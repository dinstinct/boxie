export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Keep installed-client pairing links and the established OAuth return URL.
    const legacyApp = url.pathname === '/' && (['onboarding','browserMailbox','vaultSpike'].some(key => url.searchParams.get(key) === '1') || url.searchParams.has('conversation'));
    if (url.pathname === '/feedback' || url.pathname === '/delete-account' || legacyApp || url.pathname === '/app' || url.pathname === '/app/') {
      url.pathname = '/app/';
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  }
};
