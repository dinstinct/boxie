import {copyFile, cp, mkdir} from 'node:fs/promises';
// The browser app stays on the same origin so existing keys and sessions survive.
// Never copy dist/macos, dist/android, the Node server, or private local data.
await mkdir('dist/web/app', {recursive:true});
await copyFile('dist/web/index.html', 'dist/web/app/index.html');
await copyFile('launch/index.html', 'dist/web/index.html');
await copyFile('launch/launch.css', 'dist/web/launch.css');
await cp('launch/privacy.html', 'dist/web/privacy.html');

for (const file of ['beta.html','beta.css','beta.js']) await copyFile(`launch/${file}`, `dist/web/${file}`);
