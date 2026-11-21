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
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.version, packageInfo.version, 'Версии package.json и manifest.json должны совпадать');
const lockInfo = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
assert.equal(lockInfo.version, packageInfo.version, 'Корневая версия package-lock.json должна совпадать');
assert.equal(lockInfo.packages[''].version, packageInfo.version, 'Версия пакета в lockfile должна совпадать');
assert.equal(manifest.background.service_worker, 'background/background.js');
assert.equal(manifest.action.default_popup, 'popup.html');
assert.equal(manifest.background.type, undefined); // Служебные entry points — самостоятельные IIFE.
assert.deepEqual(manifest.permissions, ['storage', 'downloads']);
assert.deepEqual(manifest.host_permissions, ['https://*.zvuk.com/*']);
assert.equal(manifest.content_scripts.length, 2);
for (const entry of manifest.content_scripts) {
  assert.deepEqual(entry.matches, ['https://*.zvuk.com/*']);
  assert.equal(entry.run_at, 'document_start');
}
assert.deepEqual(manifest.content_scripts.map(({ world, js }) => ({ world, js })), [
  { world: 'ISOLATED', js: ['content/content.js'] },
  { world: 'MAIN', js: ['page/page.js'] },
]);
assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");

for (const page of [manifest.action.default_popup, 'recorder.html']) {
  const html = await checkFile(page);
  assert.doesNotMatch(html, /<script\b[^>]*>\s*[^<\s]/i, `Inline script: ${page}`);
  const assetPaths = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(assetPaths.some((asset) => asset.endsWith('.js')), `JS: ${page}`);
  assert.ok(assetPaths.some((asset) => asset.endsWith('.css')), `CSS: ${page}`);
  for (const asset of assetPaths) {
    assert.doesNotMatch(asset, /^(?:https?:)?\/\//, `Удалённый ресурс: ${page}`);
    await checkFile(asset);
  }
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
