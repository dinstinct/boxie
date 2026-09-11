// @vitest-environment jsdom
import {act, StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({
  saved:vi.fn(), open:vi.fn(), activate:vi.fn(), pending:vi.fn(), consume:vi.fn(), firebase:vi.fn()
}));
vi.mock('./OnboardingApp',()=>({OnboardingApp:()=> <div>Legacy cloud setup callback</div>}));
vi.mock('../App',()=>({App:()=> <div>Actual inbox screen</div>}));
vi.mock('../mail/BrowserMailboxApp',()=>({CloudMailboxApp:()=> <div>Existing cloud inbox</div>}));
vi.mock('../vault-spike/local-store',()=>({hasSavedCloudVault:mocks.saved}));
vi.mock('./local-mailbox',()=>({activateLocalMailbox:mocks.activate,openLocalMailbox:mocks.open}));
vi.mock('./vault-setup',()=>({onboardingFirebaseClient:mocks.firebase}));
vi.mock('./microsoft-browser',()=>({hasPendingOutlookRedirect:mocks.pending,consumeOutlookRedirectAccount:mocks.consume,
  microsoftBrowserClientId:()=> 'configured',chooseOutlookAccount:vi.fn()}));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(()=>{
  vi.resetModules(); vi.clearAllMocks();
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  window.history.replaceState({},'', '/app');
  mocks.saved.mockResolvedValue(false);mocks.open.mockResolvedValue(null);mocks.pending.mockReturnValue(false);
  mocks.firebase.mockImplementation(()=>{throw new Error('Firebase must not be needed');});
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
async function mount() {
  const {LocalMailboxApp}=await import('./LocalMailboxApp');
  await act(async()=>{root.render(<StrictMode><LocalMailboxApp /></StrictMode>);});
}
it('fresh /app offers Outlook immediately without creating a Firebase client', async()=>{
  await mount();
  expect(container.textContent).toContain('Connect personal Outlook');
  expect(container.textContent).not.toContain('Setup needed');
  expect(mocks.firebase).not.toHaveBeenCalled();
});
it('consumes an Outlook callback once and reaches inbox even if initial Graph refresh fails', async()=>{
  mocks.pending.mockReturnValue(true);mocks.consume.mockResolvedValue({homeAccountId:'test'});
  const refresh=vi.fn().mockRejectedValue(new Error('Graph offline'));
  mocks.activate.mockResolvedValue({refresh});
  await mount();
  expect(mocks.consume).toHaveBeenCalledTimes(1);expect(mocks.activate).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Actual inbox screen');expect(mocks.firebase).not.toHaveBeenCalled();
});
it('restores a local inbox without waiting for cloud auth', async()=>{
  mocks.open.mockResolvedValue({});await mount();
  expect(container.textContent).toContain('Actual inbox screen');expect(mocks.firebase).not.toHaveBeenCalled();
});
it('leaves failed Microsoft sign-in retryable without creating local data', async()=>{
  mocks.pending.mockReturnValue(true);mocks.consume.mockRejectedValue(new Error('Microsoft sign-in cancelled'));
  await mount();
  expect(container.textContent).toContain('Microsoft sign-in cancelled');
  expect(container.querySelector('button')?.disabled).toBe(false);
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('preserves pre-release cloud OAuth returns instead of creating a local inbox',async()=>{
  window.history.replaceState({},'', '/?onboarding=1');
  mocks.pending.mockReturnValue(true);mocks.saved.mockResolvedValue(true);
  await mount();
  expect(container.textContent).toContain('Legacy cloud setup callback');
  expect(mocks.consume).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();
});
