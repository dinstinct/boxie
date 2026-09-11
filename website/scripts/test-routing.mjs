import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {default: worker} = await import(pathToFileURL(resolve('cloudflare/worker.js')).href);
const paths = new Map([
  ['/','/'], ['/app','/app/'], ['/app/','/app/'],
  ['/?onboarding=1','/app/?onboarding=1'],
  ['/?browserMailbox=1','/app/?browserMailbox=1'],
  ['/?cloudVault=1','/app/?cloudVault=1'],
  ['/?cloudMailbox=1','/app/?cloudMailbox=1'],
  ['/?vaultSpike=1&pairing=example','/app/?vaultSpike=1&pairing=example'],
  ['/feedback','/app/'], ['/delete-account','/app/'],
  ['/redirect.html','/redirect.html'], ['/privacy.html','/privacy.html'],
]);
for(const [path,expected] of paths) {
  let requested;
  await worker.fetch(new Request(`https://boxie.example${path}`),{ASSETS:{fetch:async request=>{requested=new URL(request.url);return new Response('ok');}}});
  assert.equal(requested.pathname+requested.search,expected,path);
}
console.log(`${paths.size} browser routing cases passed.`);
