import {
  graphDeltaPageSchema,
  graphMessageSchema,
  type GraphDeltaPage,
  type OutlookFolderKind
} from "../../server/providers/outlook/types";

const graphOrigin = "https://graph.microsoft.com";
const graphBaseUrl = `${graphOrigin}/v1.0`;
const transientStatuses = new Set([429, 500, 502, 503, 504]);

export class GraphHttpError extends Error {constructor(public readonly status: number) {super(`Microsoft Graph request failed with status ${status}`);}}

export class BrowserOutlookGraphClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly maximumAttempts = 3
  ) {}

  async getDeltaPage(url: string): Promise<GraphDeltaPage> {
    const response = await this.request(url, {
      Accept: "application/json",
      Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"'
    });
    return graphDeltaPageSchema.parse(await response.json());
  }

  async getMessage(id: string, folder: OutlookFolderKind, metadataOnly = false) {
    const url = new URL(`${graphBaseUrl}/me/mailFolders/${folder === 'inbox' ? 'Inbox' : 'SentItems'}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set('$select', metadataOnly ? 'id,receivedDateTime' : new URL(buildBrowserInitialDeltaUrl(folder, '1970-01-01T00:00:00Z')).searchParams.get('$select')!);
    const response = await this.request(url.toString(), {Accept: 'application/json', Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"'});
    const message = graphMessageSchema.parse(await response.json());
    if (message.id !== id) throw new Error("Outlook returned a different message identity");
    return message;
  }

  private async request(rawUrl: string, headers: Record<string, string>): Promise<Response> {
    const url = assertGraphUrl(rawUrl);
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const token = await this.getAccessToken();
      let response: Response;
      try {
        response = await this.fetchImplementation.call(globalThis, url, {
          method: "GET",
          headers: { ...headers, Authorization: `Bearer ${token}` }
        });
      } catch (caught) {
        lastError = caught instanceof Error
          ? caught
          : new Error("Microsoft Graph request failed");
        if (attempt === this.maximumAttempts) throw lastError;
        await wait(250 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) return response;
      lastError = new GraphHttpError(response.status);
      if (!transientStatuses.has(response.status) || attempt === this.maximumAttempts) {
        throw lastError;
      }
      await wait(retryDelay(response, attempt));
    }
    throw lastError ?? new Error("Microsoft Graph request failed");
  }
}

export function buildBrowserInitialDeltaUrl(
  folderKind: OutlookFolderKind,
  activatedAt: string
): string {
  const folderName = folderKind === "inbox" ? "Inbox" : "SentItems";
  const url = new URL(
    `${graphBaseUrl}/me/mailFolders('${folderName}')/messages/delta`
  );
  url.searchParams.set("$filter", `receivedDateTime ge ${activatedAt}`);
  url.searchParams.set("$select", [
    "id",
    "internetMessageId",
    "conversationId",
    "conversationIndex",
    "subject",
    "sender",
    "from",
    "toRecipients",
    "ccRecipients",
    "bccRecipients",
    "receivedDateTime",
    "sentDateTime",
    "createdDateTime",
    "lastModifiedDateTime",
    "hasAttachments",
    "importance",
    "inferenceClassification",
    "isRead",
    "bodyPreview",
    "body",
    "uniqueBody",
    "webLink"
  ].join(","));
  return url.toString();
}

function assertGraphUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.origin !== graphOrigin || !url.pathname.startsWith("/v1.0/")) {
    throw new Error("Refusing to send a Microsoft access token outside Graph v1.0");
  }
  return url.toString();
}

function retryDelay(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1_000, 30_000)
    : 250 * 2 ** (attempt - 1);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
