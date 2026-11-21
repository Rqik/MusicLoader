import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const npmCli = process.env.npm_execpath;

async function fixture(context: TestContext) {
  const tempRoot = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'music-loader-version-'));
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith('music-loader-version-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(root, 'scripts'));
  const scripts = Object.fromEntries(Object.entries(packageInfo.scripts).filter(([name]) => name === 'version' || name === 'preversion' || name.startsWith('version:')));
  const basePackage = { name: 'music-loader-version-fixture', version: '0.2.0', private: true, scripts };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(basePackage, null, 2));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    name: basePackage.name, version: basePackage.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: basePackage.name, version: basePackage.version } },
  }, null, 2));
  const manifest = '{\n  "manifest_version": 3,\n  "version": "0.2.0",\n  "permissions": ["storage", "downloads"]\n}\n';
  await writeFile(path.join(root, 'public/manifest.json'), manifest);
  await copyFile(new URL('../scripts/version.mjs', import.meta.url), path.join(root, 'scripts/version.mjs'));
  async function npm(script: string) {
    assert.ok(npmCli, 'Запустите проверку через npm test');
    return execute(process.execPath, [npmCli, 'run', script], { cwd: root, timeout: 30_000, env: { ...process.env, npm_config_offline: 'true' } });
  }
  async function versions() {
    const files = await Promise.all(['package.json', 'package-lock.json', 'public/manifest.json'].map(async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'))));
    return [files[0].version, files[1].version, files[1].packages[''].version, files[2].version];
  }
  return { root, npm, versions, manifest };
}

it('bumps patch/minor/major through real npm hooks and keeps checks read-only', { skip: !npmCli }, async (context) => {
  const project = await fixture(context);
  for (const [kind, expected] of [['patch', '0.2.1'], ['minor', '0.3.0'], ['major', '1.0.0']]) {
    await project.npm(`version:${kind}`);
    assert.deepEqual(await project.versions(), Array(4).fill(expected));
    await project.npm('version:check');
    assert.deepEqual(await project.versions(), Array(4).fill(expected));
    assert.equal(await readFile(path.join(project.root, 'public/manifest.json'), 'utf8'), project.manifest.replace('0.2.0', expected!));
  }
});

it('rejects manifest drift before a bump can mutate package and lock versions', { skip: !npmCli }, async (context) => {
  const project = await fixture(context);
  await writeFile(path.join(project.root, 'public/manifest.json'), project.manifest.replace('0.2.0', '0.1.0'));
  await assert.rejects(project.npm('version:check'));
  await assert.rejects(project.npm('version:patch'));
  assert.deepEqual(await project.versions(), ['0.2.0', '0.2.0', '0.2.0', '0.1.0']);
});
