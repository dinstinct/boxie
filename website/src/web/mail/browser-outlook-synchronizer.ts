import {
  isRemovedMessage,
  type OutlookFolderKind
} from "../../server/providers/outlook/types";
import type { BrowserCanonicalMailbox } from "./canonical-types";
import type { BrowserCanonicalMailStore } from "./browser-canonical-mail-store";
import {
  BrowserOutlookGraphClient,
  buildBrowserInitialDeltaUrl
} from "./browser-outlook-graph-client";

export interface BrowserOutlookSyncResult {
  folderKind: OutlookFolderKind;
  discovered: number;
  inserted: number;
  updated: number;
  removed: number;
  pages: number;
  deltaLink: string;
}

export class BrowserOutlookSynchronizer {
  constructor(
    private readonly store: BrowserCanonicalMailStore,
    private readonly graph: BrowserOutlookGraphClient,
    private readonly options: {
      maximumPages?: number;
      maximumItems?: number;
      now?: () => Date;
    } = {}
  ) {}

  async syncFolder(
    inputMailbox: BrowserCanonicalMailbox,
    folderKind: OutlookFolderKind
  ): Promise<{ mailbox: BrowserCanonicalMailbox; result: BrowserOutlookSyncResult }> {
    const now = this.options.now ?? (() => new Date());
    const startedAt = now().toISOString();
    let mailbox = await this.store.startSync(inputMailbox, folderKind, startedAt);
    const counts = { discovered: 0, inserted: 0, updated: 0, removed: 0, pages: 0 };
    let nextUrl = mailbox.cursors[folderKind].deltaLink ??
      buildBrowserInitialDeltaUrl(folderKind, mailbox.activatedAt);
    let finalDeltaLink: string | undefined;

    try {
      while (nextUrl) {
        counts.pages += 1;
        if (counts.pages > (this.options.maximumPages ?? 200)) {
          throw new Error("Outlook delta round exceeded its page safety limit");
        }
        const page = await this.graph.getDeltaPage(nextUrl);
        counts.discovered += page.value.length;
        if (counts.discovered > (this.options.maximumItems ?? 5_000)) {
          throw new Error("Outlook delta round exceeded its item safety limit");
        }
        const observedAt = now().toISOString();
        const messages = [];
        const removals = [];
        for (const item of page.value) {
          if (isRemovedMessage(item)) {
            removals.push({
              providerMessageId: item.id,
              reason: item["@removed"].reason ?? null,
              observedAt
            });
          } else {
            messages.push({
              folderKind,
              message: item,
              observedAt
            });
          }
        }
        const persisted = await this.store.persistPage(mailbox, messages, removals);
        counts.inserted += persisted.inserted;
        counts.updated += persisted.updated;
        counts.removed += persisted.removed;

        const nextLink = page["@odata.nextLink"];
        const deltaLink = page["@odata.deltaLink"];
        if (nextLink && deltaLink) {
          throw new Error("Outlook delta page returned both nextLink and deltaLink");
        }
        if (!nextLink && !deltaLink) {
          throw new Error("Outlook delta page returned no continuation link");
        }
        finalDeltaLink = deltaLink;
        nextUrl = nextLink ?? "";
      }

      if (!finalDeltaLink) {
        throw new Error("Outlook delta round did not produce a deltaLink");
      }
      mailbox = await this.store.completeSync(
        mailbox,
        folderKind,
        now().toISOString(),
        finalDeltaLink
      );
      return {
        mailbox,
        result: { folderKind, deltaLink: finalDeltaLink, ...counts }
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown sync error";
      await this.store.failSync(mailbox, folderKind, now().toISOString(), message);
      throw caught;
    }
  }
}
