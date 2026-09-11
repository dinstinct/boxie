import { describe, expect, it } from "vitest";
import type { GraphDeltaPage } from "../../server/providers/outlook/types";
import type { LocalVaultState } from "../vault-spike/types";
import { BrowserCanonicalMailStore } from "./browser-canonical-mail-store";
import { MemoryEncryptedCanonicalRepository } from "./encrypted-canonical-repository";
import { BrowserOutlookGraphClient } from "./browser-outlook-graph-client";
import { BrowserOutlookSynchronizer } from "./browser-outlook-synchronizer";

describe("BrowserOutlookSynchronizer", () => {
  it("persists pages before atomically advancing the final encrypted checkpoint", async () => {
    const store = BrowserCanonicalMailStore.create({
      localVault: { uid: "user", vaultId: "vault", epoch: 1 } as LocalVaultState,
      vaultKey: new Uint8Array(32).fill(4),
      repository: new MemoryEncryptedCanonicalRepository()
    });
    const mailbox = await store.activateOutlookAccount({
      providerAccountId: "account-1",
      emailAddress: "me@example.com",
      activatedAt: "2026-08-30T10:00:00.000Z"
    });
    const pages = new Map<string, GraphDeltaPage>([
      ["first", {
        value: [{ id: "message-1", subject: "Hello" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2"
      }],
      ["https://graph.microsoft.com/v1.0/page-2", {
        value: [{ id: "message-2", subject: "Hi" }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/final-delta"
      }]
    ]);
    const graph = {
      getDeltaPage: async (url: string) => pages.get(url.includes("messages/delta") ? "first" : url)!
    } as BrowserOutlookGraphClient;
    const synchronizer = new BrowserOutlookSynchronizer(store, graph, {
      now: monotonicClock()
    });

    const synced = await synchronizer.syncFolder(mailbox, "inbox");
    expect(synced.result).toMatchObject({ pages: 2, inserted: 2, discovered: 2 });
    expect(synced.mailbox.cursors.inbox.deltaLink).toContain("final-delta");
    expect(await store.listMessages(synced.mailbox)).toHaveLength(2);
  });
});

function monotonicClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 10, 0, tick++));
}
