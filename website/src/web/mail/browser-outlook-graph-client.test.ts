import { describe, expect, it, vi } from "vitest";
import { BrowserOutlookGraphClient } from "./browser-outlook-graph-client";

describe("BrowserOutlookGraphClient", () => {
  it("invokes a browser fetch implementation with the global receiver", async () => {
    const fetchImplementation = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(new Response(JSON.stringify({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta"
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;
    const graph = new BrowserOutlookGraphClient(
      async () => "device-session-token",
      fetchImplementation
    );

    await expect(graph.getDeltaPage(
      "https://graph.microsoft.com/v1.0/me/mailFolders('Inbox')/messages/delta"
    )).resolves.toMatchObject({ value: [] });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("validates delta responses and applies immutable IDs", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta"
      }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const graph = new BrowserOutlookGraphClient(
      async () => "device-session-token",
      fetchImplementation
    );

    await expect(graph.getDeltaPage(
      "https://graph.microsoft.com/v1.0/me/mailFolders('Inbox')/messages/delta"
    )).resolves.toMatchObject({ value: [] });
    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer device-session-token",
      Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"'
    });
  });

  it("never sends a token to a continuation URL outside Graph v1.0", async () => {
    const getAccessToken = vi.fn(async () => "device-session-token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const graph = new BrowserOutlookGraphClient(getAccessToken, fetchImplementation);

    await expect(graph.getDeltaPage("https://attacker.example/collect"))
      .rejects.toThrow("Refusing to send");
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
