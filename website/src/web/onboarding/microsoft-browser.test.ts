// @vitest-environment jsdom
import {beforeEach, expect, it, vi} from 'vitest';
const sdk = vi.hoisted(()=>({initialize:vi.fn(),handleRedirectPromise:vi.fn(),setActiveAccount:vi.fn(),clearCache:vi.fn()}));
vi.mock('@azure/msal-browser',()=>({BrowserCacheLocation:{SessionStorage:'session'},PublicClientApplication:class {
  initialize=sdk.initialize;handleRedirectPromise=sdk.handleRedirectPromise;setActiveAccount=sdk.setActiveAccount;clearCache=sdk.clearCache;
}}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();vi.stubEnv('VITE_BOXIE_MICROSOFT_CLIENT_ID','synthetic-id');sessionStorage.setItem('boxie.outlookRedirectPending','1');});
it('rejects work identity before reading Graph and clears the pending callback',async()=>{
  sdk.handleRedirectPromise.mockResolvedValue({account:{homeAccountId:'work',tenantId:'organization',username:'worker@example.com'},accessToken:'fixture'});
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const {consumeOutlookRedirectAccount}=await import('./microsoft-browser');
  await expect(consumeOutlookRedirectAccount()).rejects.toThrow('personal Outlook');
  expect(fetch).not.toHaveBeenCalled();expect(sdk.clearCache).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem('boxie.outlookRedirectPending')).toBeNull();
});
it('validates read-only mailbox access for the selected personal identity',async()=>{
  sdk.handleRedirectPromise.mockResolvedValue({account:{homeAccountId:'personal',tenantId:'9188040d-6c67-4c5b-b112-36a304b66dad',username:'owner@example.com'},accessToken:'fixture'});
  const fetch=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',fetch);
  const {consumeOutlookRedirectAccount}=await import('./microsoft-browser');
  expect((await consumeOutlookRedirectAccount())?.homeAccountId).toBe('personal');
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('$select=id'),expect.any(Object));
  expect(sessionStorage.getItem('boxie.outlookRedirectPending')).toBeNull();
});
