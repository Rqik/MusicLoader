import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv[2];
assert.ok(process.argv.length === 3 && (mode === '--check' || mode === '--sync'), 'Укажите --check или --sync');
const root = process.cwd();
const [packageText, lockText, manifestText] = await Promise.all([
  readFile(path.join(root, 'package.json'), 'utf8'),
  readFile(path.join(root, 'package-lock.json'), 'utf8'),
  readFile(path.join(root, 'public/manifest.json'), 'utf8'),
]);
const packageInfo = JSON.parse(packageText);
const lock = JSON.parse(lockText);
const manifest = JSON.parse(manifestText);
const version = packageInfo.version;
assert.equal(typeof version, 'string');
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Нужна версия major.minor.patch без суффиксов');
assert.ok(version.split('.').every((part) => Number(part) <= 65535) && version !== '0.0.0', 'Версия вне допустимого диапазона Chrome');
assert.equal(lock.version, version, 'Версии package.json и package-lock.json не совпадают');
assert.equal(lock.packages?.['']?.version, version, 'Версия корневого пакета в package-lock.json не совпадает');

if (mode === '--sync' && manifest.version !== version) {
  // Preserve the manifest's existing formatting; only its root version changes.
  const nextManifest = manifestText.replace(/^(  "version"\s*:\s*")[^"]*(")/m, (_match, prefix, suffix) => `${prefix}${version}${suffix}`);
  assert.equal(JSON.parse(nextManifest).version, version, 'Не удалось обновить version в public/manifest.json');
  await writeFile(path.join(root, 'public/manifest.json'), nextManifest);
} else {
  assert.equal(manifest.version, version, 'Версии package.json и public/manifest.json не совпадают. Используйте npm run version:patch/minor/major');
}
console.log(`Версия ${version}: package.json, package-lock.json и Manifest согласованы`);
