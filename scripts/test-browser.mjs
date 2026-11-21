import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const extensionPath = path.join(projectRoot, 'dist');
const { version: extensionVersion } = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
const artifactsPath = path.join(projectRoot, 'artifacts');
await mkdir(artifactsPath, { recursive: true });

const recordingFixtureTitle = 'MusicLoader Own Audio Recording Fixture';
const profilePath = await mkdtemp(path.join(artifactsPath, 'browser-profile-'));

const errors = [];
const expectedHttpFailures = new Map();
let downloadCount = 0;
let expectedDownloadCount = 0;

let context;
let server;
try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: process.env.MUSICLOADER_BROWSER_CHANNEL ?? 'chromium',
    headless: true,
    viewport: null,
    // Playwright's headless mute also silences the captured test tab.
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', `--auto-select-tab-capture-source-by-title=${recordingFixtureTitle}`],
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const status = expectedHttpFailures.get(message.location().url);
      if (status && message.text().startsWith(`Failed to load resource: the server responded with a status of ${status}`)) return;
      errors.push(message.text());
    });
    page.on('download', () => { downloadCount += 1; });
  });
  // Browser-level CDP поддерживает также branded Chrome, где --load-extension отключён.
  const session = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).hostname, extensionId);

  // Настоящее окно действия: Chrome сам определяет размеры, без эмуляции viewport.
  // Такие окна не входят в context.pages(), поэтому проверяем их через CDP.
  await worker.evaluate(() => chrome.action.openPopup());
  const { targetInfos } = await session.send('Target.getTargets');
  const nativePopup = targetInfos.find((target) => target.url === `chrome-extension://${extensionId}/popup.html`);
  assert.ok(nativePopup, 'Chrome должен открыть настоящее окно расширения');
  const { sessionId } = await session.send('Target.attachToTarget', { targetId: nativePopup.targetId, flatten: false });
  let requestId = 0;
  function sendNativeCommand(method, params = {}) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      function cleanup() {
        clearTimeout(timer);
        session.off('Target.receivedMessageFromTarget', handleMessage);
      }
      function handleMessage(event) {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        cleanup();
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Chrome popup: timeout ${method}`)); }, 5000);
      session.on('Target.receivedMessageFromTarget', handleMessage);
      void session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch((error) => { cleanup(); reject(error); });
    });
  }
  await expect.poll(async () => {
    const result = await sendNativeCommand('Runtime.evaluate', {
      // Chrome ограничивает высоту экраном и может добавить место под системную полосу прокрутки.
      expression: '(()=>{const app=document.querySelector("#root > div")?.getBoundingClientRect();return {isValidWidth:innerWidth>=420&&innerWidth<=440,isValidHeight:innerHeight>=420&&innerHeight<=600,isContentVisible:app?.width===420&&app.left>=0&&app.right<=innerWidth,isFooterVisible:(document.querySelector("footer")?.getBoundingClientRect().bottom??Infinity)<=innerHeight}})()',
      returnByValue: true,
    });
    return result.result.value;
  }).toEqual({ isValidWidth: true, isValidHeight: true, isContentVisible: true, isFooterVisible: true });
  let nativeScreenshot;
  await expect.poll(async () => {
    try {
      nativeScreenshot = await sendNativeCommand('Page.captureScreenshot', { captureBeyondViewport: false });
      return Boolean(nativeScreenshot.data);
    } catch { return false; }
  }, { timeout: 5000, intervals: [100, 250, 500] }).toBe(true);
  await writeFile(path.join(artifactsPath, 'popup-native.png'), Buffer.from(nativeScreenshot.data, 'base64'));
  await session.send('Target.closeTarget', { targetId: nativePopup.targetId });
  await session.detach();

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 420, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'MusicLoader', exact: true })).toBeVisible();
  const card = popup.getByRole('region', { name: 'Плеер Звука' });
  await expect(card.getByText('Откройте Звук', { exact: true })).toBeVisible();
  await expect(popup.getByRole('link', { name: 'Открыть Звук', exact: true })).toHaveAttribute('href', 'https://zvuk.com/');
  const disclosure = popup.locator('summary').filter({ hasText: 'Дополнительные действия' });
  const download = popup.getByRole('button', { name: 'Скачать песню', exact: true });
  const trackLink = popup.getByRole('link', { name: 'Открыть композицию', exact: true });
  async function openAdditionalActions() {
    await expect(disclosure).toBeVisible();
    if (!await disclosure.evaluate((summary) => summary.parentElement.open)) await disclosure.click();
  }

  async function checkLayout(page, width, height, { popupSurface = false } = {}) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(({ popupSurface }) => {
      const main = document.querySelector('main');
      const footer = document.querySelector('footer');
      return {
        fitsWidth: document.documentElement.scrollWidth === innerWidth && main.scrollWidth === main.clientWidth,
        footerVisible: !popupSurface || (footer?.getBoundingClientRect().bottom ?? Infinity) <= innerHeight,
      };
    }, { popupSurface });
    assert.deepEqual(layout, { fitsWidth: true, footerVisible: true }, `Границы интерфейса при ширине ${width} px`);
  }
  assert.deepEqual(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'PING' })), { type: 'PONG' });

  // Собственный fixture проверяет реальную MV3-инъекцию, не обращаясь к сервису.
  const fixtureArtwork = await readFile(path.join(extensionPath, 'artwork', 'wave.svg'));
  async function installFixture(page) {
    await page.route('https://zvuk.com/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/cover.svg') return route.fulfill({ contentType: 'image/svg+xml', body: fixtureArtwork });
      if (pathname.startsWith('/audio/')) return route.fulfill({ contentType: 'audio/flac', body: '' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="ru"><title>Fixture Звука</title><body><section><a href="/track/999">Другой трек</a><p>Другой артист</p></section><footer><div id="player"><a id="track" href="/track/81400222"><p title="Очень-очень">Очень-очень</p></a><p id="artist">ARTIK &amp; ASTI</p></div></footer><audio></audio></body></html>' });
    });
    await page.goto('https://zvuk.com/extension-test');
  }
  async function setTrack(page, { title = 'Очень-очень', artist = 'ARTIK & ASTI', album = '#РайОдинНаДвоих', id = '81400222', playbackState = 'none', artwork = 'https://zvuk.com/cover.svg' } = {}) {
    await page.evaluate(({ title, artist, album, id, playbackState, artwork }) => {
      const anchor = document.querySelector('#track');
      anchor.href = `/track/${id}`;
      anchor.textContent = title;
      document.querySelector('#artist').textContent = artist;
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork: [{ src: artwork, sizes: '320x320', type: 'image/svg+xml' }] });
      navigator.mediaSession.playbackState = playbackState;
    }, { title, artist, album, id, playbackState, artwork });
  }
  const state = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PLAYER_STATE' }));
  await context.route('https://zvuk.com/cover.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body: fixtureArtwork }));
  const fixture = await context.newPage();
  await installFixture(fixture);
  await fixture.bringToFront();
  await expect(card.getByText('Ожидание метаданных', { exact: true })).toBeVisible();
  await expect(popup.getByRole('heading', { name: /^Демоочередь/ })).toHaveCount(0);
  await expect(popup.getByRole('listitem')).toHaveCount(0);
  await expect(download).toHaveCount(0);
  await setTrack(fixture);
  await expect(card.getByRole('heading', { name: 'Очень-очень', exact: true })).toBeVisible();
  await expect(card.getByText('ARTIK & ASTI', { exact: true })).toBeVisible();
  await expect(card.getByText('#РайОдинНаДвоих', { exact: true })).toBeVisible();
  // Подтверждённая исходниками форма image-optimizer: MAIN → storage → Popup, без настоящих изображений сервиса.
  const optimizedArtwork = `https://cdn-new.zvuk.com/desktop-data/_next/image?url=${encodeURIComponent('https://cdn-image.zvuk.com/pic/fixture.jpg')}&w=280&q=75`;
  await context.route('https://cdn-new.zvuk.com/desktop-data/_next/image**', (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('url'), 'https://cdn-image.zvuk.com/pic/fixture.jpg');
    assert.equal(url.searchParams.get('w'), '280');
    assert.equal(url.searchParams.get('q'), '75');
    return route.fulfill({ contentType: 'image/svg+xml', body: fixtureArtwork });
  });
  await setTrack(fixture, { artwork: optimizedArtwork });
  await expect(card.getByRole('img', { name: 'Обложка альбома' })).toHaveAttribute('src', optimizedArtwork);
  await expect.poll(() => card.getByRole('img', { name: 'Обложка альбома' }).evaluate((image) => image.complete && image.naturalWidth === 320)).toBe(true);
  await expect.poll(async () => (await state()).sources[0]?.track?.artwork).toBe(optimizedArtwork);
  await popup.reload();
  await expect(card.getByRole('img', { name: 'Обложка альбома' })).toHaveAttribute('src', optimizedArtwork);
  await setTrack(fixture);
  await expect(card.getByRole('img', { name: 'Обложка альбома' })).toHaveAttribute('src', 'https://zvuk.com/cover.svg');
  await expect(trackLink).toHaveAttribute('href', 'https://zvuk.com/track/81400222');
  await expect(popup.getByRole('region', { name: 'Диагностика аудио' })).toHaveCount(0);
  for (const width of [320, 390, 1440]) {
    await checkLayout(popup, width, 600, { popupSurface: true });
    assert.ok((await download.boundingBox()).height >= 44);
    await popup.screenshot({ path: path.join(artifactsPath, `popup-live-${width}.png`), animations: 'disabled' });
  }
  await popup.setViewportSize({ width: 420, height: 600 });
  await download.focus();
  await popup.keyboard.press('Tab');
  await expect(trackLink).toBeFocused();
  await popup.keyboard.press('Tab');
  await expect(disclosure).toBeFocused();
  assert.equal(await disclosure.evaluate((summary) => getComputedStyle(summary).outlineWidth), '2px');
  await popup.keyboard.press('Enter');
  const recordLink = popup.getByRole('link', { name: 'Записать звук вкладки', exact: true });
  await expect(recordLink).toBeVisible();
  await popup.keyboard.press('Tab');
  await expect(recordLink).toBeFocused();
  await popup.keyboard.press('Shift+Tab');
  await expect(disclosure).toBeFocused();
  await popup.keyboard.press('Space');
  await expect(recordLink).toHaveCount(0);
  await popup.keyboard.press('Enter');
  await expect(card.getByText('Текущий трек', { exact: true })).toBeVisible();
  await expect(card.getByRole('img')).toBeVisible();
  await expect(card.getByText('Воспроизводится', { exact: true })).toHaveCount(0);
  await expect(popup.getByText('Звук подключён', { exact: true })).toBeVisible();
  await popup.screenshot({ path: path.join(artifactsPath, 'popup-live.png'), animations: 'disabled' });
  const first = (await state()).sources[0];
  await fixture.waitForTimeout(1600);
  assert.equal((await state()).sources[0].updatedAt, first.updatedAt, 'Одинаковые metadata не должны создавать обновления');

  // Проверяем доступ к Media Session в отдельном isolated world, а не предполагаем его.
  const pageSession = await context.newCDPSession(fixture);
  const { frameTree } = await pageSession.send('Page.getFrameTree');
  const { executionContextId } = await pageSession.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'musicloader-verification' });
  const isolated = await pageSession.send('Runtime.evaluate', { contextId: executionContextId, expression: 'navigator.mediaSession?.metadata?.title ?? null', returnByValue: true });
  const isolatedMetadataVisible = isolated.result.value === 'Очень-очень';
  console.log(`Media Session на fixture: MAIN title доступен; isolated metadata ${isolatedMetadataVisible ? 'видимы в этом Chrome' : 'отсутствуют'}. Расширение читает MAIN.`);
  await pageSession.detach();

  // Реальный виджет рендерит исполнителей отдельными ссылками и span-разделителем.
  await setTrack(fixture, { title: 'Совместный трек', artist: 'Alice, Bob', id: '64001' });
  await fixture.evaluate(() => { document.querySelector('#artist').innerHTML = '<a href="/artist/1">Alice</a><span>, </span><a href="/artist/2">Bob</a>'; });
  await expect(card.getByRole('heading', { name: 'Совместный трек', exact: true })).toBeVisible();
  await expect(card.getByText('Alice, Bob', { exact: true })).toBeVisible();
  await expect(trackLink).toHaveAttribute('href', 'https://zvuk.com/track/64001');
  await setTrack(fixture);
  await expect(card.getByRole('heading', { name: 'Очень-очень', exact: true })).toBeVisible();

  // Смена metadata и маршрута без перезагрузки документа.
  await fixture.evaluate(() => history.pushState({}, '', '/playlist/fixture'));
  await setTrack(fixture, { title: 'Следующая композиция', artist: 'Тестовый исполнитель', album: 'Тестовый альбом', id: '42', playbackState: 'playing' });
  await expect(card.getByRole('heading', { name: 'Следующая композиция', exact: true })).toBeVisible();
  await expect(card.getByText('Воспроизводится', { exact: true })).toBeVisible();
  await expect(trackLink).toHaveAttribute('href', 'https://zvuk.com/track/42');
  await popup.reload();
  await expect(card.getByRole('heading', { name: 'Следующая композиция', exact: true })).toBeVisible();
  await openAdditionalActions();

  // Неоднозначные ID остаются null, затем подтверждённая идентичность восстанавливается.
  await fixture.evaluate(() => {
    const duplicate = document.createElement('section');
    duplicate.id = 'duplicate';
    duplicate.innerHTML = '<a href="/track/43">Следующая композиция</a><p>Тестовый исполнитель</p>';
    document.body.append(duplicate);
  });
  await expect(trackLink).toHaveCount(0);
  await expect(popup.getByText('ID и ссылка не определены однозначно')).toBeVisible();
  await fixture.evaluate(() => document.querySelector('#duplicate').remove());
  await expect(trackLink).toHaveAttribute('href', 'https://zvuk.com/track/42');

  // Диагностика включается вручную и хранит только обезличенные признаки.
  const diagnosticPanel = popup.getByRole('region', { name: 'Диагностика аудио' });
  await openAdditionalActions();
  await diagnosticPanel.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect.poll(async () => (await state()).diagnostics[0]?.report !== null).toBe(true);
  await fixture.evaluate(async () => {
    await fetch('/audio/fixture.flac?token=DO_NOT_STORE_SECRET');
    document.querySelector('audio').dispatchEvent(new Event('encrypted'));
  });
  await expect(diagnosticPanel.getByText('Признаки формата: FLAC', { exact: true })).toBeVisible();
  await expect(diagnosticPanel.getByText('EME/DRM: есть признаки EME; система DRM не определена', { exact: true })).toBeVisible();
  const diagnostics = (await state()).diagnostics[0];
  assert.equal(diagnostics.report.quality, null);
  assert.doesNotMatch(JSON.stringify(diagnostics), /DO_NOT_STORE_SECRET|https:|fixture\.flac|token=/);
  await popup.reload();
  await expect(diagnosticPanel).toHaveCount(0);
  await openAdditionalActions();
  await expect(diagnosticPanel.getByText('Признаки формата: FLAC', { exact: true })).toBeVisible();
  await diagnosticPanel.getByRole('button', { name: 'Выключить', exact: true }).click();
  await expect.poll(async () => (await state()).diagnostics[0]?.report).toBe(null);

  // Активная пустая вкладка имеет приоритет; поля двух источников не смешиваются.
  const second = await context.newPage();
  await installFixture(second);
  await second.bringToFront();
  await expect(card.getByText('Ожидание метаданных', { exact: true })).toBeVisible();
  await setTrack(second, { title: 'Вторая вкладка', artist: 'Другой исполнитель', album: 'Другой альбом', id: '50', playbackState: 'paused' });
  await expect(card.getByRole('heading', { name: 'Вторая вкладка', exact: true })).toBeVisible();
  await popup.bringToFront();
  await expect(card.getByRole('heading', { name: 'Следующая композиция', exact: true })).toBeVisible();
  await second.close();
  await expect.poll(async () => (await state()).sources.length).toBe(1);

  // Принудительно останавливаем MV3 worker и восстанавливаем состояние из storage.
  const serviceSession = await context.newCDPSession(popup);
  let versions = [];
  serviceSession.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => { versions = updates; });
  await serviceSession.send('ServiceWorker.enable');
  await expect.poll(() => versions.find((version) => version.scriptURL === `chrome-extension://${extensionId}/background/background.js`)?.versionId).toBeTruthy();
  const version = versions.find((item) => item.scriptURL === `chrome-extension://${extensionId}/background/background.js`);
  await serviceSession.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await popup.reload();
  await expect(card.getByRole('heading', { name: 'Следующая композиция', exact: true })).toBeVisible();
  await serviceSession.detach();
  await setTrack(fixture, { title: 'После перезапуска worker', id: '51', playbackState: 'paused' });
  await expect(card.getByRole('heading', { name: 'После перезапуска worker', exact: true })).toBeVisible();
  // Тот же механизм повторного запроса используется после очистки ID старого сеанса браузера.
  const sourceAfterRestart = (await state()).sources[0];
  await popup.evaluate(async (tabId) => {
    await chrome.storage.local.remove(`player.tab.${tabId}`);
    await chrome.tabs.sendMessage(tabId, { type: 'REFRESH_PLAYER' }, { frameId: 0 });
  }, sourceAfterRestart.tabId);
  await expect.poll(async () => (await state()).sources[0]?.track?.title).toBe('После перезапуска worker');

  // После pagehide таймер выключен; pageshow.persisted создаёт один новый мост.
  await fixture.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await setTrack(fixture, { title: 'Возврат к странице', id: '52' });
  await fixture.waitForTimeout(1300);
  const hiddenSource = (await state()).sources[0];
  assert.equal(hiddenSource.track, null, 'Без работающего content script старые metadata не должны выглядеть подключёнными');
  assert.equal(hiddenSource.connection, 'waiting');
  assert.equal(await popup.evaluate(async (tabId) => (await chrome.storage.local.get(`player.tab.${tabId}`))[`player.tab.${tabId}`].track.title, hiddenSource.tabId), 'После перезапуска worker', 'Остановленный polling не должен обновлять сохранённый снимок');
  await fixture.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(card.getByRole('heading', { name: 'Возврат к странице', exact: true })).toBeVisible();

  // Ошибка getter не ломает polling; восстановление не требует перезагрузки.
  await fixture.evaluate(() => Object.defineProperty(navigator.mediaSession, 'metadata', { configurable: true, get() { throw new Error('Fixture read error'); } }));
  await expect(card.getByText('Не удалось получить данные', { exact: true })).toBeVisible();
  await fixture.evaluate(() => { delete navigator.mediaSession.metadata; navigator.mediaSession.metadata = null; });
  await expect(card.getByText('Ожидание метаданных', { exact: true })).toBeVisible();
  await setTrack(fixture);
  await expect(card.getByRole('heading', { name: 'Очень-очень', exact: true })).toBeVisible();

  // Уход с домена очищает снимок; возврат создаёт новый независимый документ.
  await fixture.goto('about:blank');
  await expect(card.getByText('Откройте Звук', { exact: true })).toBeVisible();
  await expect.poll(async () => (await state()).sources.length).toBe(0);
  await fixture.goto('https://zvuk.com/extension-test');
  await setTrack(fixture);
  await expect(card.getByRole('heading', { name: 'Очень-очень', exact: true })).toBeVisible();
  await fixture.reload();
  await expect(card.getByText('Ожидание метаданных', { exact: true })).toBeVisible();
  await setTrack(fixture);
  await expect(card.getByRole('heading', { name: 'Очень-очень', exact: true })).toBeVisible();

  // Запрос скачивания разрешается только по текущему источнику; сетевые API страницы не подменяются расширением.
  await expect(popup.getByRole('heading', { name: /^Демоочередь/ })).toHaveCount(0);
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Аудиофайл и доступный HLS-плейлист не обнаружены. Обновите вкладку Звука, включите трек и повторите попытку. Если ошибка останется, включите диагностику и скопируйте отчёт.', { exact: true })).toBeVisible();
  let inspectedPlaylistRequests = 0;
  await fixture.route('https://cdn-hls-slicer.zvuk.com/**', (route) => {
    inspectedPlaylistRequests += 1;
    assert.equal(route.request().headers().cookie, undefined);
    assert.ok(route.request().url().endsWith('.m3u8'), 'Инспектор не должен запрашивать сегменты или ключи');
    return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'access-control-allow-origin': '*' }, body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="private/init.mp4"\n#EXTINF:4,\nprivate/part.m4s\n#EXT-X-ENDLIST\n' });
  });
  await fixture.evaluate(() => fetch('https://cdn-hls-slicer.zvuk.com/fixture/master.m3u8', { credentials: 'omit' }).then((response) => response.text()));
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Плейлист этой композиции ещё не обнаружен. Обновите вкладку Звука, включите трек и повторите попытку.', { exact: true })).toBeVisible();
  await context.addCookies([{ name: 'diagnosticTestCookie', value: 'TEST_ONLY_NOT_REAL', domain: 'cdn-hls-slicer.zvuk.com', path: '/', secure: true, httpOnly: true }]);
  // Пустая история воспроизводит присланный candidateCount: 0; новые записи должны прийти через observer.
  await fixture.evaluate(() => performance.clearResourceTimings());
  await fixture.addScriptTag({ content: await readFile(path.join(projectRoot, 'scripts/inspect-zvuk-hls.js'), 'utf8') });
  const initialHlsReport = await fixture.evaluate(() => window.musicLoaderHlsReport.report());
  assert.equal(initialHlsReport.version, 2);
  assert.equal(initialHlsReport.isRunning, true);
  assert.equal(initialHlsReport.candidateCount, 0, 'При пустой истории инспектор должен ждать новые запросы');
  await fixture.evaluate(() => fetch('https://cdn-hls-slicer.zvuk.com/fixture/live-capture.m3u8', { credentials: 'omit' }).then((response) => response.text()));
  const hlsReport = await fixture.evaluate(() => window.musicLoaderHlsReport.done);
  assert.equal(hlsReport.status, 'completed');
  assert.equal(hlsReport.candidateCount, 1);
  assert.equal(hlsReport.playlists[0].status, 'inspected');
  assert.equal(hlsReport.playlists[0].manifest.kind, 'media');
  assert.equal(hlsReport.metadataStableDuringInspection, true);
  assert.equal(hlsReport.playlists[0].currentPlaylistAssociation, 'unconfirmed');
  assert.equal(hlsReport.playlists[0].observedVia, 'observer');
  assert.equal(inspectedPlaylistRequests, 3);
  assert.doesNotMatch(JSON.stringify(hlsReport), /TEST_ONLY_NOT_REAL|https:\/\/|private\/|master\.m3u8|init\.mp4|part\.m4s/);
  const downloadWorker = context.serviceWorkers().find((item) => item.url() === `chrome-extension://${extensionId}/background/background.js`);
  assert.ok(downloadWorker);
  // Проверяем весь мост и параметры Chrome API через тестовый приёмник без сетевого скачивания с zvuk.com.
  await downloadWorker.evaluate(() => {
    globalThis.downloadTest = { original: chrome.downloads.download, originalSearch: chrome.downloads.search, calls: [], failure: null };
    chrome.downloads.download = async (options) => {
      if (globalThis.downloadTest.failure) throw new Error(globalThis.downloadTest.failure);
      globalThis.downloadTest.calls.push(options); return 7000 + globalThis.downloadTest.calls.length;
    };
    chrome.downloads.search = async (query) => query.id >= 7001 && query.id <= 7000 + globalThis.downloadTest.calls.length
      ? [{ id: query.id, state: 'in_progress' }] : globalThis.downloadTest.originalSearch(query);
  });
  try {
    await fixture.evaluate(() => Object.defineProperty(document.querySelector('audio'), 'currentSrc', { configurable: true, value: 'https://zvuk.com/audio/public-fixture.mp3' }));
    await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
    await expect(popup.getByText('Скачивание передано Chrome. Статус доступен в списке загрузок браузера.', { exact: true })).toBeVisible();
    const calls = await downloadWorker.evaluate(() => globalThis.downloadTest.calls);
    assert.deepEqual(calls, [{ url: 'https://zvuk.com/audio/public-fixture.mp3', filename: 'MusicLoader/ARTIK & ASTI - Очень-очень.mp3', saveAs: true, conflictAction: 'uniquify' }]);
    await fixture.evaluate(() => Object.defineProperty(document.querySelector('audio'), 'currentSrc', { configurable: true, value: 'https://zvuk.com/audio/direct-song.mp4' }));
    await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
    await expect(popup.getByText('Скачивание передано Chrome. Статус доступен в списке загрузок браузера.', { exact: true })).toBeVisible();
    await expect.poll(() => downloadWorker.evaluate(() => globalThis.downloadTest.calls.length)).toBe(2);
    assert.equal(await downloadWorker.evaluate(() => globalThis.downloadTest.calls[1].url), 'https://zvuk.com/audio/direct-song.mp4', 'HLS другого трека не должен блокировать обычный MP4 текущего трека');
    const beforeNative = JSON.stringify(await popup.evaluate(() => chrome.storage.local.get(null)));
    assert.doesNotMatch(beforeNative, /public-fixture\.mp3/);
    await fixture.evaluate(() => Object.defineProperty(document.querySelector('audio'), 'currentSrc', { configurable: true, value: 'https://zvuk.com/audio/private.mp3?token=DO_NOT_STORE_SECRET' }));
    await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
    await expect(popup.getByText('Источник содержит служебные параметры доступа. Нужен обезличенный диагностический отчёт.', { exact: true })).toBeVisible();
    await popup.reload();
    await expect(popup.getByText('Источник содержит служебные параметры доступа. Нужен обезличенный диагностический отчёт.', { exact: true })).toBeVisible();
    await expect(popup.getByText(`v${extensionVersion}`, { exact: true })).toBeVisible();
    await openAdditionalActions();
    await popup.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { globalThis.copiedDownloadReport = value; } } }));
    await popup.getByRole('button', { name: 'Копировать диагностику', exact: true }).click();
    await expect(popup.getByText('Диагностика скопирована', { exact: true })).toBeVisible();
    const copiedStatus = await popup.evaluate(() => globalThis.copiedDownloadReport);
    assert.equal(JSON.parse(copiedStatus).attempt.reason, 'private-url');
    assert.equal(JSON.parse(copiedStatus).extensionVersion, extensionVersion);
    assert.doesNotMatch(copiedStatus, /DO_NOT_STORE_SECRET|https:|blob:|private\.mp3|artwork/);
    await fixture.evaluate(() => Object.defineProperty(document.querySelector('audio'), 'currentSrc', { configurable: true, value: 'https://zvuk.com/audio/public-fixture.mp3' }));
    await downloadWorker.evaluate(() => { globalThis.downloadTest.failure = 'Download canceled: https://private.test/?token=DO_NOT_STORE_SECRET'; });
    await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
    await expect(popup.getByText(/Chrome не начал скачивание\. Код: USER_CANCELED/)).toBeVisible();
    await popup.reload();
    await expect(popup.getByText(/Chrome не начал скачивание\. Код: USER_CANCELED/)).toBeVisible();
    assert.doesNotMatch(JSON.stringify(await popup.evaluate(() => chrome.storage.local.get(null))), /DO_NOT_STORE_SECRET|private\.test/);
    await downloadWorker.evaluate(() => { globalThis.downloadTest.failure = null; });
    await fixture.evaluate(() => Object.defineProperty(document.querySelector('audio'), 'currentSrc', { configurable: true, value: 'blob:https://zvuk.com/private-blob' }));
    await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
    await expect(popup.getByText('Плейлист этой композиции ещё не обнаружен. Обновите вкладку Звука, включите трек и повторите попытку.', { exact: true })).toBeVisible();
    await fixture.evaluate(() => {
      const media = document.querySelector('audio');
      Object.defineProperty(media, 'currentSrc', { configurable: true, value: 'https://zvuk.com/audio/public-fixture.mp3' });
      media.dispatchEvent(new Event('encrypted'));
    });
    await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
    await expect(popup.getByText('Обнаружены признаки защищённого воспроизведения. Сохранение такого источника не поддерживается.', { exact: true })).toBeVisible();
    assert.equal(await downloadWorker.evaluate(() => globalThis.downloadTest.calls.length), 2);
  } finally {
    await downloadWorker.evaluate(() => { chrome.downloads.download = globalThis.downloadTest.original; chrome.downloads.search = globalThis.downloadTest.originalSearch; delete globalThis.downloadTest; });
  }
  await fixture.close();
  await expect(card.getByText('Откройте Звук', { exact: true })).toBeVisible();
  await expect.poll(async () => Object.keys(await popup.evaluate(() => chrome.storage.local.get(null))).filter((key) => key.startsWith('player.tab.') || key.startsWith('diagnostics.tab.')).length).toBe(0);

  // Полный путь: собственный AES-128 HLS → MAIN → Blob → настоящий Chrome Download → побайтовая сверка.
  // Закрытый адрес плейлиста должен объясняться явно, даже когда в DOM нет media-элемента.
  const restrictedPage = await context.newPage();
  await installFixture(restrictedPage);
  await setTrack(restrictedPage, { title: 'Проверка недоступного плейлиста', id: '77701' });
  await restrictedPage.evaluate(() => document.querySelector('audio').remove());
  let restrictedRequests = 0;
  await restrictedPage.route('https://cdn-hls-slicer.zvuk.com/**', (route) => {
    restrictedRequests += 1;
    return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n' });
  });
  await restrictedPage.bringToFront();
  await expect(card.getByRole('heading', { name: 'Проверка недоступного плейлиста', exact: true })).toBeVisible();
  await restrictedPage.evaluate(() => fetch('https://cdn-hls-slicer.zvuk.com/tracks/77701/master.m3u8?token=DO_NOT_STORE_SECRET', { credentials: 'omit' }).then((response) => response.text()));
  await openAdditionalActions();
  await diagnosticPanel.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(diagnosticPanel.getByText(/Исключено: параметры доступа — [1-9]/)).toBeVisible();
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Этот адрес или его параметры не входят в поддерживаемую схему HLS. Сохранение не началось.', { exact: true })).toBeVisible();
  await popup.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { globalThis.copiedDownloadReport = value; } } }));
  await openAdditionalActions();
  await popup.getByRole('button', { name: 'Копировать диагностику', exact: true }).click();
  await expect(popup.getByText('Диагностика скопирована', { exact: true })).toBeVisible();
  const restrictedReport = await popup.evaluate(() => globalThis.copiedDownloadReport);
  const discovery = JSON.parse(restrictedReport).diagnostics.report.hlsDiscovery;
  assert.equal(discovery.matchingPlaylists, 0);
  assert.ok(discovery.rejectedPrivate > 0);
  assert.equal(discovery.acceptedObservations, 0);
  assert.equal(restrictedRequests, 1, 'Downloader не должен запрашивать исключённый адрес');
  assert.doesNotMatch(restrictedReport, /DO_NOT_STORE_SECRET|https:|token=|master\.m3u8/);
  await restrictedPage.close();
  await expect(card.getByText('Откройте Звук', { exact: true })).toBeVisible();
  assert.equal(downloadCount, 0, 'До явного запроса готового файла скачиваний быть не должно');
  const hlsDownloadControl = await context.browser().newBrowserCDPSession();
  const hlsDownloadDirectory = path.join(artifactsPath, 'browser-downloads');
  await mkdir(hlsDownloadDirectory, { recursive: true });
  await hlsDownloadControl.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: hlsDownloadDirectory, eventsEnabled: true });
  const clearInit = await readFile(path.join(projectRoot, 'tests/fixtures/hls/init.mp4'));
  const clearSegments = await Promise.all(Array.from({ length: 5 }, (_, index) => readFile(path.join(projectRoot, `tests/fixtures/hls/segment${index}.m4s`))));
  const expectedAudioBytes = Buffer.concat([clearInit, ...clearSegments]);
  const ownKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const initIv = Buffer.alloc(16, 3);
  function encrypt(bytes, iv) { const cipher = createCipheriv('aes-128-cbc', ownKey, iv); return Buffer.concat([cipher.update(bytes), cipher.final()]); }
  const encryptedInit = encrypt(clearInit, initIv);
  const encryptedSegments = clearSegments.map((bytes, index) => {
    const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(7 + index), 8); return encrypt(bytes, iv);
  });
  const masterText = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64780,CODECS="mp4a.40.29"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=129451,CODECS="mp4a.40.2"\nmid.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=257479,CODECS="mp4a.40.2"\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=945387,CODECS="fLaC"\nlossless.m3u8\n';
  let useUnsupportedDrm = false;
  let slowHlsReply = false;
  let isInitDenied = false;
  let isKeyDenied = false;
  let isZvukKeySelected = true;
  let keyRequests = 0;
  const requestedResources = [];
  function mediaText() {
    if (useUnsupportedDrm) return '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd:must-not-request"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\npart0.m4s\n#EXT-X-ENDLIST\n';
    const declaredKey = isZvukKeySelected ? 'https://zvuk.com/keyserver/api/v1/key?track_id=60001&quality=hq&content_type=track' : 'key.bin';
    return `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="${declaredKey}",IV=0x${initIv.toString('hex')}\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="${declaredKey}"\n${clearSegments.map((_, index) => `#EXTINF:0.2,\npart${index}.m4s`).join('\n')}\n#EXT-X-ENDLIST\n`;
  }
  const hlsPage = await context.newPage();
  await installFixture(hlsPage);
  await hlsPage.route('https://cdn-hls-slicer.zvuk.com/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const requestHeaders = await request.allHeaders();
    assert.equal(requestHeaders.cookie, undefined, 'HLS CDN не должен получать cookies');
    assert.equal(requestHeaders['x-encrypted-key'], undefined, 'Одноразовое значение предназначено для ключевого сервера Звука');
    assert.ok(pathname.startsWith('/drm/track/t60001-fixture/'));
    const resource = pathname.split('/').at(-1);
    requestedResources.push(resource);
    await new Promise((resolve) => setTimeout(resolve, slowHlsReply && resource === 'high.m3u8' ? 10000 : 80));
    const headers = { 'access-control-allow-origin': '*' };
    if (resource === 'master.m3u8') return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body: masterText });
    if (resource === 'high.m3u8') return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body: mediaText() });
    if (resource === 'mid.m3u8') {
      const body = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="clear-init.mp4"\n${clearSegments.map((_, index) => `#EXTINF:0.2,\nclear-part${index}.m4s`).join('\n')}\n#EXT-X-ENDLIST\n`;
      return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body });
    }
    if (resource === 'clear-init.mp4') return route.fulfill({ headers, contentType: 'audio/mp4', body: clearInit });
    if (resource === 'key.bin') {
      keyRequests += 1;
      return route.fulfill({ headers, contentType: 'application/octet-stream', body: ownKey });
    }
    if (resource === 'init.mp4') {
      if (isInitDenied) {
        expectedHttpFailures.set(request.url(), 503);
        return route.fulfill({ status: 503, headers, body: 'Own fixture init unavailable' });
      }
      return route.fulfill({ headers, contentType: 'audio/mp4', body: encryptedInit });
    }
    const part = /^part([0-4])\.m4s$/.exec(resource);
    if (part) return route.fulfill({ headers, contentType: 'audio/mp4', body: encryptedSegments[Number(part[1])] });
    const clearPart = /^clear-part([0-4])\.m4s$/.exec(resource);
    if (clearPart) return route.fulfill({ headers, contentType: 'audio/mp4', body: clearSegments[Number(clearPart[1])] });
    throw new Error('Unexpected HLS resource request');
  });
  await context.addCookies([{ name: 'ownTestCookie', value: 'TEST_ONLY_NOT_REAL', domain: 'zvuk.com', path: '/', secure: true, httpOnly: true }]);
  await hlsPage.route('https://zvuk.com/keyserver/api/v1/key**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    assert.equal(request.method(), 'GET');
    assert.match(headers.cookie ?? '', /ownTestCookie=TEST_ONLY_NOT_REAL/, 'Браузер отправляет тестовую cookie ключевому серверу своего origin');
    assert.equal(headers.authorization, undefined, 'Запрос identity-ключа не должен отправлять Authorization');
    assert.match(headers['x-encrypted-key'] ?? '', /^[A-Za-z0-9]{8}$/, 'Ключевой сервер должен получить одноразовое значение');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['content_type', 'quality', 'track_id']);
    assert.equal(url.searchParams.get('track_id'), '60001');
    assert.equal(url.searchParams.get('quality'), 'hq');
    assert.equal(url.searchParams.get('content_type'), 'track');
    keyRequests += 1;
    if (isKeyDenied) {
      expectedHttpFailures.set(request.url(), 400);
      return route.fulfill({ status: 400, body: 'Own fixture key denied DO_NOT_COPY_RESPONSE_BODY' });
    }
    return route.fulfill({ contentType: 'application/octet-stream', body: ownKey });
  });
  await setTrack(hlsPage, { title: 'Собственный HLS тест', artist: 'MusicLoader test', album: 'Fixture', id: '60001', playbackState: 'paused' });
  await hlsPage.bringToFront();
  await expect(card.getByRole('heading', { name: 'Собственный HLS тест', exact: true })).toBeVisible();
  await hlsPage.evaluate(() => fetch('https://cdn-hls-slicer.zvuk.com/drm/track/t60001-fixture/master.m3u8', { credentials: 'omit' }).then((response) => response.text()));
  await hlsPage.evaluate(() => Object.defineProperty(document.querySelector('audio'), 'currentSrc', { configurable: true, value: 'https://cdn-hls-slicer.zvuk.com/drm/track/t60001-fixture/init.mp4' }));
  isInitDenied = true;
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Запрос начального фрагмента отклонён сервером (HTTP 503). Файл не сохранён.', { exact: true })).toBeVisible();
  assert.equal(keyRequests, 0, 'Сбой init не должен маскироваться как ошибка запроса ключа');
  isInitDenied = false;
  isKeyDenied = true;
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Запрос ключа отклонён сервером (HTTP 400). Файл не сохранён.', { exact: true })).toBeVisible();
  await popup.reload();
  await expect(popup.getByText('Запрос ключа отклонён сервером (HTTP 400). Файл не сохранён.', { exact: true })).toBeVisible();
  await popup.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { globalThis.copiedDownloadReport = value; } } }));
  await openAdditionalActions();
  await popup.getByRole('button', { name: 'Копировать диагностику', exact: true }).click();
  await expect(popup.getByText('Диагностика скопирована', { exact: true })).toBeVisible();
  const failedKeyReport = await popup.evaluate(() => globalThis.copiedDownloadReport);
  assert.equal(JSON.parse(failedKeyReport).version, 3);
  assert.deepEqual(JSON.parse(failedKeyReport).attempt.request, { resource: 'key', kind: 'http', httpStatus: 400 });
  assert.equal(JSON.parse(failedKeyReport).attempt.progress, 15);
  assert.equal(JSON.parse(failedKeyReport).attempt.downloadId, null);
  assert.doesNotMatch(failedKeyReport, /TEST_ONLY_NOT_REAL|DO_NOT_COPY_RESPONSE_BODY|https:|keyserver|X-Encrypted-Key/);
  assert.equal(keyRequests, 1, 'После отказа ключа автоматических повторов быть не должно');
  isKeyDenied = false;
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Сервер принял запрос и вернул ключ в формате плеера Звука. Для сохранения звука используй «Записать звук вкладки».', { exact: true })).toBeVisible();
  assert.equal(keyRequests, 2, 'Ответ в формате плеера не приводит к повторному запросу');
  assert.equal(await popup.evaluate(async () => (await chrome.downloads.search({})).length), 0);

  isZvukKeySelected = false;
  keyRequests = 0;
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByRole('progressbar', { name: 'Подготовка аудиофайла' })).toBeVisible();
  await expect(popup.getByText(/Скачивание передано Chrome\.|Файл сохранён\./)).toBeVisible({ timeout: 20000 });
  const ownDownload = await popup.evaluate(async () => (await chrome.downloads.search({})).find((item) => item.url.startsWith('blob:https://zvuk.com/')));
  assert.ok(ownDownload, 'Подготовленный HLS должен попасть в настоящий список Chrome Downloads');
  await expect.poll(() => popup.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.state, ownDownload.id)).toBe('complete');
  assert.ok(!path.relative(hlsDownloadDirectory, ownDownload.filename).startsWith('..'));
  const savedAudio = await readFile(ownDownload.filename);
  assert.deepEqual(savedAudio, expectedAudioBytes, 'В M4A должны быть исходный init и все расшифрованные фрагменты по порядку');
  assert.equal(keyRequests, 1, 'Один identity-ключ должен переиспользоваться для init и сегментов');
  assert.equal(requestedResources.some((resource) => /low|mid|lossless/.test(resource)), false, 'По умолчанию выбирается лучший AAC, а не FLAC или низкое качество');
  const playback = await hlsPage.evaluate(async (bytes) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }));
    const audio = document.createElement('audio'); audio.muted = true; audio.src = url; document.body.append(audio);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Own M4A playback timeout')), 8000);
        audio.addEventListener('ended', () => { clearTimeout(timer); resolve({ ended: true, duration: audio.duration }); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Own M4A decode failed')); }, { once: true });
        void audio.play().catch(reject);
      });
    } finally { audio.remove(); URL.revokeObjectURL(url); }
  }, [...savedAudio]);
  assert.equal(playback.ended, true);
  assert.ok(playback.duration > 0 && playback.duration < 2);
  assert.doesNotMatch(JSON.stringify(await popup.evaluate(() => chrome.storage.local.get(null))), /key\.bin|master\.m3u8|blob:https|00112233445566778899aabbccddeeff|keyserver|TEST_ONLY_NOT_REAL|DO_NOT_COPY_RESPONSE_BODY/);
  // Плеер на Web Audio может не иметь audio/video в DOM: HLS должен работать по наблюдению плейлиста.
  await hlsPage.evaluate(() => document.querySelectorAll('audio, video').forEach((element) => element.remove()));
  useUnsupportedDrm = true;
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText('Обнаружены признаки защищённого воспроизведения. Сохранение такого источника не поддерживается.', { exact: true })).toBeVisible();
  assert.equal(keyRequests, 1, 'DRM-вариант должен остановиться до чтения ключей');
  assert.equal(await popup.evaluate(async () => (await chrome.downloads.search({})).length), 1, 'DRM-вариант не должен создавать файл');
  // Остановка worker в процессе подготовки должна отменить задачу, а повторный запрос — создать новую.
  useUnsupportedDrm = false;
  slowHlsReply = true;
  let abortedHlsRequests = 0;
  hlsPage.on('requestfailed', (request) => { if (request.url().endsWith('/high.m3u8')) abortedHlsRequests += 1; });
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByRole('progressbar', { name: 'Подготовка аудиофайла' })).toBeVisible();
  const stopJobSession = await context.newCDPSession(popup);
  let activeVersions = [];
  stopJobSession.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => { activeVersions = updates; });
  await stopJobSession.send('ServiceWorker.enable');
  await expect.poll(() => activeVersions.find((item) => item.scriptURL === `chrome-extension://${extensionId}/background/background.js` && item.runningStatus === 'running')?.versionId).toBeTruthy();
  const activeJobVersion = activeVersions.find((item) => item.scriptURL === `chrome-extension://${extensionId}/background/background.js` && item.runningStatus === 'running');
  await stopJobSession.send('ServiceWorker.stopWorker', { versionId: activeJobVersion.versionId });
  await expect.poll(() => abortedHlsRequests, { timeout: 12000 }).toBeGreaterThan(0);
  await expect(popup.getByRole('button', { name: 'Скачать песню', exact: true })).toBeEnabled();
  assert.equal(await popup.evaluate(async () => (await chrome.downloads.search({})).length), 1);
  slowHlsReply = false;
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect(popup.getByText(/Скачивание передано Chrome\.|Файл сохранён\./)).toBeVisible({ timeout: 20000 });
  await expect.poll(() => popup.evaluate(async () => (await chrome.downloads.search({ state: 'complete' })).length)).toBe(2);
  await stopJobSession.detach();

  // Известный браузеру открытый вариант остаётся доступен при ответе ключевого сервера в формате плеера.
  await hlsPage.evaluate(() => fetch('https://cdn-hls-slicer.zvuk.com/drm/track/t60001-fixture/mid.m3u8', { credentials: 'omit' }).then((response) => response.text()));
  isZvukKeySelected = true;
  const previousKeyRequests = keyRequests;
  const previousDownloadIds = await popup.evaluate(async () => (await chrome.downloads.search({ state: 'complete' })).map(({ id }) => id));
  await popup.getByRole('button', { name: 'Скачать песню', exact: true }).click();
  await expect.poll(() => popup.evaluate(async () => (await chrome.downloads.search({ state: 'complete' })).length), { timeout: 20000 }).toBe(3);
  const fallbackDownload = await popup.evaluate(async (previousIds) => (await chrome.downloads.search({ state: 'complete' }))
    .find(({ id }) => !previousIds.includes(id)), previousDownloadIds);
  assert.ok(fallbackDownload?.url.startsWith('blob:https://zvuk.com/'));
  assert.ok(!path.relative(hlsDownloadDirectory, fallbackDownload.filename).startsWith('..'));
  assert.deepEqual(await readFile(fallbackDownload.filename), expectedAudioBytes);
  assert.equal(keyRequests, previousKeyRequests + 1, 'Ответ ключа в формате плеера не должен приводить к повторному запросу');
  assert.equal(requestedResources.filter((resource) => /^clear-part/.test(resource)).length, clearSegments.length);
  expectedDownloadCount = downloadCount;
  await hlsPage.close();
  await hlsDownloadControl.detach();
  await expect(card.getByText('Откройте Звук', { exact: true })).toBeVisible();

  // DEMO возвращается только после закрытия всех вкладок Звука.
  await popup.reload();
  await expect(popup.getByRole('progressbar')).toBeVisible();
  await popup.getByRole('button', { name: 'Приостановить очередь', exact: true }).click();
  await popup.screenshot({ path: path.join(artifactsPath, 'popup.png'), animations: 'disabled' });
  const progress = await popup.getByRole('progressbar').getAttribute('aria-valuenow');
  await popup.waitForTimeout(850);
  assert.equal(await popup.getByRole('progressbar').getAttribute('aria-valuenow'), progress, 'Пауза должна остановить прогресс');

  await popup.getByRole('button', { name: 'Повторить: На своей волне' }).click();
  await expect(popup.getByText('Демоошибка', { exact: true })).toHaveCount(0);
  await popup.getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await expect(popup.getByRole('tabpanel').getByText('Готово', { exact: true })).toHaveCount(3, { timeout: 25_000 });
  await popup.getByRole('tab', { name: /^Готово/ }).click();
  await expect(popup.getByRole('listitem')).toHaveCount(3);
  await popup.getByRole('button', { name: 'Очистить завершённые' }).click();
  await expect(popup.getByText('Готовых треков пока нет')).toBeVisible();
  await popup.getByRole('tab', { name: 'Все', exact: true }).click();
  await expect(popup.getByText('Нет демозагрузок')).toBeVisible();
  await popup.screenshot({ path: path.join(artifactsPath, 'popup-empty.png'), animations: 'disabled' });

  await popup.getByRole('button', { name: 'О расширении' }).click();
  await expect(popup.getByRole('dialog')).toBeVisible();
  await popup.screenshot({ path: path.join(artifactsPath, 'popup-dialog.png'), animations: 'disabled' });
  await popup.keyboard.press('Escape');
  await expect(popup.getByRole('dialog')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'О расширении' })).toBeFocused();

  // Новый документ создаёт новую popup-очередь, без неявной синхронизации с background.
  await popup.reload();
  await expect(popup.getByRole('listitem')).toHaveCount(3);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Горизонтального переполнения быть не должно');

  // Предпросмотр в обычной вкладке тоже работает, без Chrome runtime API.
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (pathname === '/test-audio.wav') { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(Buffer.alloc(44)); return; }
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
  await expect(preview.getByRole('region', { name: 'Плеер Звука' }).getByText('Откройте Звук', { exact: true })).toBeVisible();
  const previewAction = preview.getByRole('link', { name: 'Открыть Звук', exact: true });
  for (const width of [320, 390, 1440]) {
    await checkLayout(preview, width, 480, { popupSurface: true });
    assert.ok((await previewAction.boundingBox()).height >= 44);
    await preview.screenshot({ path: path.join(artifactsPath, `preview-${width}.png`), animations: 'disabled' });
  }
  const queueTab = preview.getByRole('tab', { name: 'Все', exact: true });
  await queueTab.focus();
  await preview.keyboard.press('ArrowRight');
  await expect(preview.getByRole('tab', { name: 'В очереди', exact: true })).toHaveAttribute('aria-selected', 'true');
  assert.equal(downloadCount, expectedDownloadCount, 'Без поддержанного явного запроса скачиваний быть не должно');
  // Отдельно проверяем настоящий Chrome Downloads API на собственных локальных байтах.
  const downloadSession = await context.browser().newBrowserCDPSession();
  const downloadPath = path.join(artifactsPath, 'browser-downloads');
  await mkdir(downloadPath, { recursive: true });
  await downloadSession.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
  const nativeDownloadId = await popup.evaluate((url) => chrome.downloads.download({ url, filename: 'MusicLoader/browser-test.wav', saveAs: true, conflictAction: 'uniquify' }), `http://127.0.0.1:${server.address().port}/test-audio.wav`);
  await expect.poll(async () => popup.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.state, nativeDownloadId)).toBe('complete');
  const nativeDownloadFile = await popup.evaluate(async (id) => (await chrome.downloads.search({ id }))[0].filename, nativeDownloadId);
  assert.ok(!path.relative(downloadPath, nativeDownloadFile).startsWith('..'));
  assert.deepEqual(await readFile(nativeDownloadFile), Buffer.alloc(44));

  // Настоящий getDisplayMedia получает аудио локальной страницы через выбор вкладки Chrome.
  const recordingSource = await context.newPage();
  await installFixture(recordingSource);
  await recordingSource.evaluate((title) => {
    document.title = title;
    const button = document.createElement('button');
    button.textContent = 'Воспроизвести тестовый сигнал';
    button.addEventListener('click', () => {
      const output = new AudioContext();
      const oscillator = output.createOscillator();
      const volume = output.createGain();
      volume.gain.value = 0.08;
      oscillator.connect(volume).connect(output.destination);
      oscillator.start();
    }, { once: true });
    document.body.append(button);
  }, recordingFixtureTitle);
  await setTrack(recordingSource, { title: 'Запись тестового сигнала', id: '60123' });
  await recordingSource.getByRole('button', { name: 'Воспроизвести тестовый сигнал' }).click();
  await recordingSource.bringToFront();
  await expect(card.getByRole('heading', { name: 'Запись тестового сигнала', exact: true })).toBeVisible();
  await openAdditionalActions();
  const [recorder] = await Promise.all([
    context.waitForEvent('page'),
    popup.getByRole('link', { name: 'Записать звук вкладки', exact: true }).click(),
  ]);
  await expect(recorder.getByRole('heading', { name: 'Запись звука вкладки', exact: true })).toBeVisible();
  await recorder.bringToFront();
  await recorder.keyboard.press('Tab');
  await expect(recorder.getByRole('button', { name: 'Начать запись', exact: true })).toBeFocused();
  await recorder.keyboard.press('Enter');
  await expect(recorder.getByText(/^Запись идёт\./)).toBeVisible({ timeout: 10000 });
  await expect(recorder.getByRole('button', { name: 'Остановить запись', exact: true })).toBeFocused();
  await recorder.waitForTimeout(1600); // Даём реальному захвату записать больше одного фрагмента.
  await recorder.getByRole('button', { name: 'Остановить запись', exact: true }).click();
  await expect(recorder.getByText('Запись готова', { exact: true })).toBeVisible();
  await expect(recorder.getByRole('button', { name: 'Сохранить WebM', exact: true })).toBeFocused();
  const clip = await recorder.locator('audio').evaluate(async (audio) => {
    const bytes = await fetch(audio.src).then((response) => response.arrayBuffer());
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(bytes.slice(0));
      const peak = decoded.getChannelData(0).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      return { bytes: [...new Uint8Array(bytes)], url: audio.src, duration: decoded.duration, peak };
    } finally {
      await context.close();
    }
  });
  assert.ok(clip.duration > 0.5, 'В WebM должна быть запись длительностью больше 500 мс');
  assert.ok(clip.peak > 0.01, `WebM должен содержать звук тестового сигнала (пик ${clip.peak})`);
  for (const width of [320, 390, 1440]) {
    await checkLayout(recorder, width, 600);
    await recorder.screenshot({ path: path.join(artifactsPath, `recorder-${width}.png`), animations: 'disabled' });
  }
  await recorder.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException('Fixture selection denied', 'NotAllowedError'); };
    globalThis.originalRecorderDownload = chrome.downloads.download;
    chrome.downloads.download = async () => { throw new Error('Fixture save denied'); };
  });
  await recorder.getByRole('button', { name: 'Новая запись', exact: true }).press('Enter');
  await expect(recorder.getByRole('status')).toHaveText('Доступ к вкладке не предоставлен.');
  await expect(recorder.locator('audio')).toHaveAttribute('src', clip.url);
  await recorder.getByRole('button', { name: 'Сохранить WebM', exact: true }).press('Enter');
  await expect(recorder.getByRole('status')).toHaveText('Chrome не сохранил запись. Можно повторить сохранение.');
  await expect(recorder.locator('audio')).toHaveAttribute('src', clip.url);
  await recorder.evaluate(() => { chrome.downloads.download = globalThis.originalRecorderDownload; });
  await recorder.getByRole('button', { name: 'Сохранить WebM', exact: true }).click();
  await expect.poll(() => recorder.evaluate(async (url) => (await chrome.downloads.search({ url }))[0]?.state, clip.url)).toBe('complete');
  const recordingFile = await recorder.evaluate(async (url) => (await chrome.downloads.search({ url }))[0].filename, clip.url);
  assert.ok(!path.relative(downloadPath, recordingFile).startsWith('..'));
  assert.deepEqual(await readFile(recordingFile), Buffer.from(clip.bytes));
  await recorder.close();
  await recordingSource.close();

  await downloadSession.detach();
  assert.deepEqual(errors, [], 'В браузере не должно быть необработанных ошибок');
  console.log(`Браузер ${context.browser().version()}: native popup 420 px, MAIN/isolated, track switch/SPA/dedup, storage, hidden DEMO, direct download, AES-128 HLS→M4A, X-Encrypted-Key and clear fallback, tab audio capture→WebM with audible signal, worker restart/cancel/retry, DRM blocking, dialog и preview: OK`);
  console.log('Скриншоты сохранены в artifacts/. Сайт Звука заменён локальной HTML-заглушкой.');
} catch (error) {
  const failedPopup = context?.pages().find((page) => page.url().startsWith('chrome-extension://'));
  if (failedPopup) await failedPopup.screenshot({ path: path.join(artifactsPath, 'popup-failure.png'), animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
}
