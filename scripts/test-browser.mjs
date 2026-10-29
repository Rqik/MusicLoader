import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const extensionPath = path.join(projectRoot, 'dist');
const artifactsPath = path.join(projectRoot, 'artifacts');
await mkdir(artifactsPath, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: process.env.MUSICLOADER_BROWSER_CHANNEL ?? 'chromium',
  headless: true,
  viewport: { width: 420, height: 600 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});

const errors = [];
let downloadCount = 0;
context.on('page', (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('download', () => { downloadCount += 1; });
});

let server;
try {
  // Browser-level CDP поддерживает также branded Chrome, где --load-extension отключён.
  const session = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  await session.detach();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).hostname, extensionId);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'MusicLoader.' })).toBeVisible();
  await expect(popup.getByText('Расширение подключено', { exact: true })).toBeVisible();
  assert.deepEqual(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'PING' })), { type: 'PONG' });

  // Заглушка документа проверяет реальную инъекцию content script без запросов к сервису.
  const fixture = await context.newPage();
  await fixture.route('https://zvuk.com/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ru"><title>Тестовая вкладка Звука</title><body>Локальный fixture, без музыки и API</body></html>',
  }));
  await fixture.goto('https://zvuk.com/extension-test');
  await fixture.bringToFront();
  await expect.poll(async () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PAGE' }))).toEqual({
    type: 'ACTIVE_PAGE', page: { title: 'Тестовая вкладка Звука', origin: 'https://zvuk.com' },
  });
  await popup.reload();
  await expect(popup.getByText('Связь со Звуком есть', { exact: true })).toBeVisible();
  await expect(popup.getByRole('progressbar')).toBeVisible();
  await popup.getByRole('button', { name: 'Приостановить очередь', exact: true }).click();
  await expect(popup.getByRole('listitem').last()).toBeInViewport({ ratio: 1 });
  await popup.screenshot({ path: path.join(artifactsPath, 'popup.png'), animations: 'disabled' });
  const progress = await popup.getByRole('progressbar').getAttribute('aria-valuenow');
  await popup.waitForTimeout(850);
  assert.equal(await popup.getByRole('progressbar').getAttribute('aria-valuenow'), progress, 'Пауза должна остановить прогресс');

  await popup.getByRole('button', { name: 'Добавить в очередь', exact: true }).click();
  await expect(popup.getByRole('button', { name: 'Добавлено в очередь', exact: true })).toBeDisabled();
  await expect(popup.getByRole('listitem')).toHaveCount(4);
  await popup.getByRole('button', { name: 'Следующий демотрек' }).click();
  await expect(popup.getByRole('heading', { name: 'После дождя', exact: true }).first()).toBeVisible();
  await popup.getByRole('button', { name: 'Повторить: На своей волне' }).click();
  await expect(popup.getByText('Демоошибка', { exact: true })).toHaveCount(0);
  await popup.getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await expect(popup.getByRole('tabpanel').getByText('Готово', { exact: true })).toHaveCount(4, { timeout: 25_000 });
  await popup.getByRole('tab', { name: 'Готово' }).click();
  await expect(popup.getByRole('listitem')).toHaveCount(4);
  await popup.getByRole('button', { name: 'Очистить завершённые' }).click();
  await expect(popup.getByText('Готовых треков пока нет')).toBeVisible();
  await popup.getByRole('tab', { name: 'Все', exact: true }).click();
  await expect(popup.getByText('Здесь будет твоя музыка')).toBeVisible();
  await popup.screenshot({ path: path.join(artifactsPath, 'popup-empty.png'), animations: 'disabled' });

  await popup.getByRole('button', { name: 'Добавить в очередь', exact: true }).click();
  await popup.getByRole('button', { name: 'Удалить: После дождя' }).click();
  await expect(popup.getByRole('listitem')).toHaveCount(0);
  await popup.getByRole('button', { name: 'О демонстрации' }).click();
  await expect(popup.getByRole('dialog')).toBeVisible();
  await popup.screenshot({ path: path.join(artifactsPath, 'popup-dialog.png'), animations: 'disabled' });
  await popup.keyboard.press('Escape');
  await expect(popup.getByRole('dialog')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'О демонстрации' })).toBeFocused();

  // Новый документ создаёт новую popup-очередь, без неявной синхронизации с background.
  await popup.reload();
  await expect(popup.getByRole('listitem')).toHaveCount(3);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Горизонтального переполнения быть не должно');
  const style = await popup.getByRole('button', { name: 'Добавить в очередь', exact: true }).evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
  }));
  assert.equal(style.background, 'rgb(188, 247, 123)', 'Токены Tailwind/shadcn должны применяться');

  // Предпросмотр в обычной вкладке тоже работает, без Chrome runtime API.
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const filename = path.resolve(extensionPath, `.${pathname}`);
      const relative = path.relative(extensionPath, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid path');
      const body = await readFile(filename);
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const preview = await context.newPage();
  await preview.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  await expect(preview.getByText('Предпросмотр', { exact: true })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Тёплый свет', exact: true })).toBeVisible();
  await preview.setViewportSize({ width: 320, height: 600 });
  assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await preview.screenshot({ path: path.join(artifactsPath, 'popup-narrow.png'), animations: 'disabled' });
  assert.equal(downloadCount, 0, 'Расширение не должно скачивать файлы');
  assert.deepEqual(errors, [], 'В браузере не должно быть необработанных ошибок');
  console.log(`Браузер ${context.browser().version()}: popup, MV3 worker, messaging, content script, очередь, pause/retry/filters/empty, dialog, CSS и browser preview: OK`);
  console.log('Скриншоты сохранены в artifacts/. Сайт Звука заменён локальной HTML-заглушкой.');
} catch (error) {
  const failedPopup = context.pages().find((page) => page.url().startsWith('chrome-extension://'));
  if (failedPopup) await failedPopup.screenshot({ path: path.join(artifactsPath, 'popup-failure.png'), animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  await context.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
