import {handleBeta, purgeBeta} from './beta.js';
export default {
  async scheduled(event, env) { await purgeBeta(env); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/beta/')) return handleBeta(request, env);
    if (url.pathname === '/beta' || url.pathname === '/beta/' || url.pathname === '/beta.html') {
      url.pathname = '/beta/';
      const asset = await env.ASSETS.fetch(new Request(url, request));
      const response = new Response(asset.body, asset);
      response.headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      return response;
    }
    // Keep installed-client pairing links and the established OAuth return URL.
    const legacyApp = url.pathname === '/' && (['onboarding','browserMailbox','vaultSpike'].some(key => url.searchParams.get(key) === '1') || url.searchParams.has('conversation'));
    if (url.pathname === '/feedback' || url.pathname === '/delete-account' || legacyApp || url.pathname === '/app' || url.pathname === '/app/') {
      url.pathname = '/app/';
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  }
};
