import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

async function checkFile(relativePath) {
  assert.equal(typeof relativePath, 'string');
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `Путь вне dist: ${relativePath}`);
  assert.ok((await stat(absolutePath)).isFile(), `Отсутствует файл: ${relativePath}`);
  return readFile(absolutePath, 'utf8');
}

assert.equal(manifest.manifest_version, 3);
assert.match(manifest.version, /^\d+\.\d+\.\d+(\.\d+)?$/);
assert.equal(manifest.background.service_worker, 'background/background.js');
assert.equal(manifest.action.default_popup, 'popup.html');
assert.equal(manifest.background.type, undefined); // Оба скрипта — классические IIFE.
assert.deepEqual(manifest.permissions ?? [], []);
assert.deepEqual(manifest.host_permissions ?? [], []);
assert.deepEqual(manifest.content_scripts[0].matches, ['https://*.zvuk.com/*']);
assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");

const html = await checkFile(manifest.action.default_popup);
assert.doesNotMatch(html, /<script\b[^>]*>\s*[^<\s]/i, 'В popup обнаружен inline script');
const assetPaths = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
assert.ok(assetPaths.some((asset) => asset.endsWith('.js')));
assert.ok(assetPaths.some((asset) => asset.endsWith('.css')));
for (const asset of assetPaths) {
  assert.doesNotMatch(asset, /^(?:https?:)?\/\//, 'Удалённый ресурс в popup');
  await checkFile(asset);
}

for (const scriptPath of [manifest.background.service_worker, ...manifest.content_scripts.flatMap((entry) => entry.js)]) {
  const script = await checkFile(scriptPath);
  new Script(script, { filename: scriptPath }); // import/export недопустимы в классическом скрипте.
  assert.doesNotMatch(script, /\beval\s*\(|\bnew\s+Function\s*\(/, 'Код несовместим с CSP');
  assert.doesNotMatch(script, /\bimport\s*\(|\bimportScripts\s*\(/, 'Скрипт должен быть самостоятельным');
  assert.ok(Buffer.byteLength(script) < 50_000, 'В служебный скрипт попали лишние runtime-зависимости');
}

const background = await checkFile(manifest.background.service_worker);
assert.doesNotMatch(background, /\b(?:window|document)\./, 'DOM API в service worker');

async function checkJavaScript(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkJavaScript(entryPath);
    else if (entry.name.endsWith('.js')) {
      const script = await readFile(entryPath, 'utf8');
      assert.doesNotMatch(script, /\beval\s*\(|\bnew\s+Function\s*\(/, `CSP: ${entryPath}`);
      assert.doesNotMatch(script, /webpack-dev-server|webpackHotUpdate|react-refresh/, `Dev runtime: ${entryPath}`);
    }
  }
}
await checkJavaScript(root);
for (const artwork of ['sunrise', 'rain', 'city', 'wave']) await checkFile(`artwork/${artwork}.svg`);
console.log('Manifest V3, ссылки на ресурсы, самостоятельные скрипты и CSP: OK');
