import {
  BrowserCacheLocation,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult
} from "@azure/msal-browser";

const graphScopes = ["Mail.Read"];
const outlookRedirectPendingKey = "boxie.outlookRedirectPending";

export interface SelectedOutlookAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  displayName: string | null;
}

let applicationPromise: Promise<PublicClientApplication> | null = null;
let redirectResultPromise: Promise<AuthenticationResult | null> | null = null;

export function microsoftBrowserClientId(): string | null {
  return import.meta.env.VITE_BOXIE_MICROSOFT_CLIENT_ID?.trim() || null;
}

async function application(): Promise<PublicClientApplication> {
  const clientId = microsoftBrowserClientId();
  if (!clientId) {
    throw new Error(
      "Browser Outlook onboarding is not configured. Add VITE_BOXIE_MICROSOFT_CLIENT_ID."
    );
  }
  if (!applicationPromise) {
    applicationPromise = (async () => {
      const instance = new PublicClientApplication({
        auth: {
          clientId,
          authority: "https://login.microsoftonline.com/common",
          redirectUri: `${window.location.origin}/redirect.html`
        },
        cache: {
          cacheLocation: BrowserCacheLocation.SessionStorage
        }
      });
      await instance.initialize();
      redirectResultPromise = instance.handleRedirectPromise();
      return instance;
    })();
  }
  return applicationPromise;
}

function selectedAccount(result: AuthenticationResult): SelectedOutlookAccount {
  const account: AccountInfo | null = result.account;
  if (!account?.homeAccountId || !account.username) {
    throw new Error("Microsoft did not return a usable Outlook account identity.");
  }
  return {
    homeAccountId: account.homeAccountId,
    tenantId: account.tenantId,
    username: account.username,
    displayName: account.name ?? null
  };
}

export async function chooseOutlookAccount(returnPath = "/?onboarding=1"): Promise<SelectedOutlookAccount> {
  const client = await application();
  window.sessionStorage.setItem(outlookRedirectPendingKey, "1");
  try {
    await client.loginRedirect({
      scopes: graphScopes,
      prompt: "select_account",
      redirectStartPage: `${window.location.origin}${returnPath}`
    });
  } catch (error) {
    window.sessionStorage.removeItem(outlookRedirectPendingKey);
    if (
      error &&
      typeof error === "object" &&
      "errorCode" in error &&
      String((error as { errorCode?: unknown }).errorCode) === "interaction_in_progress"
    ) {
      await client.clearCache();
      throw new Error(
        "Boxie cleared an interrupted Microsoft sign-in. Choose the Outlook account once more."
      );
    }
    throw error;
  }
  return await new Promise<SelectedOutlookAccount>(() => undefined);
}

export function hasPendingOutlookRedirect(): boolean {
  return window.sessionStorage.getItem(outlookRedirectPendingKey) === "1";
}

export async function consumeOutlookRedirectAccount(): Promise<SelectedOutlookAccount | null> {
  if (!hasPendingOutlookRedirect()) return null;
  try {
    const client = await application();
    const result = await redirectResultPromise;
    if (!result) {
      throw new Error("Microsoft returned without an Outlook account selection.");
    }
    const selected = selectedAccount(result);
    if (selected.tenantId !== "9188040d-6c67-4c5b-b112-36a304b66dad") {
      await client.clearCache({account: result.account!});
      throw new Error("Boxie currently supports personal Outlook accounts. Work and school accounts stay separate and are not supported yet.");
    }
    client.setActiveAccount(result.account);
    await validateMailboxToken(result.accessToken);
    return selected;
  } finally {
    window.sessionStorage.removeItem(outlookRedirectPendingKey);
  }
}

async function validateMailboxToken(accessToken: string): Promise<void> {
  if (!accessToken) {
    throw new Error("Microsoft did not return a mailbox access token.");
  }

  // Validate that the consented token can actually read the chosen mailbox. No
  // message body or subject is requested, and the token remains in MSAL's
  // device-local session cache.
  const response = await fetch(
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1&$select=id",
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  if (!response.ok) {
    throw new Error(`Microsoft granted a session but mailbox validation failed (${response.status}).`);
  }
}

export async function getOutlookAccessToken(homeAccountId: string): Promise<string> {
  const client = await application();
  const account = client.getAllAccounts().find(
    (candidate) => candidate.homeAccountId === homeAccountId
  );
  if (!account) {
    throw new Error("The confirmed Microsoft account is no longer available in this session.");
  }
  client.setActiveAccount(account);
  const result = await client.acquireTokenSilent({ account, scopes: graphScopes });
  if (!result.accessToken) {
    throw new Error("Microsoft did not return a mailbox access token.");
  }
  return result.accessToken;
}

export async function forgetSelectedOutlookAccount(accountId: string): Promise<void> {
  const client = await application();
  const account = client.getAllAccounts().find(
    (candidate) => candidate.homeAccountId === accountId
  );
  if (account) {
    client.setActiveAccount(null);
    await client.clearCache({ account });
  }
  window.sessionStorage.removeItem(outlookRedirectPendingKey);
}
