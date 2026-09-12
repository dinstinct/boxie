import {copyFile, cp, mkdir, readFile, writeFile} from 'node:fs/promises';
// The browser app stays on the same origin so existing keys and sessions survive.
// Never copy dist/macos, dist/android, the Node server, or private local data.
await mkdir('dist/web/app', {recursive:true});
await copyFile('dist/web/index.html', 'dist/web/app/index.html');
const betaPage = await readFile('launch/beta.html', 'utf8');
const betaContent = betaPage.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1]
  .replace(/<h1>/g, '<h2>').replace(/<\/h1>/g, '</h2>');
const homepage = (await readFile('launch/index.html', 'utf8')).replace(
  '<!-- beta-signup -->',
  `<section id="beta" class="beta-wrap beta-home" aria-label="Join the Android beta">${betaContent}</section>`
);
await writeFile('dist/web/index.html', homepage);
await copyFile('launch/launch.css', 'dist/web/launch.css');
await cp('launch/privacy.html', 'dist/web/privacy.html');

for (const file of ['beta.css','beta.js']) await copyFile(`launch/${file}`, `dist/web/${file}`);
await mkdir('dist/web/beta', {recursive:true});
// Old shared links retain the product story and all withdrawal capabilities.
await writeFile('dist/web/beta/index.html', homepage);
