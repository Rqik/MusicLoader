import { useState } from 'react';
import { ArrowUpRight, Copy, Download, LoaderCircle } from 'lucide-react';
import { Disclosure } from '@/components/Disclosure/Disclosure';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { usePlayerStore, selectCurrentSource } from '@/features/player/store/usePlayerStore';
import { sendExtensionMessage } from '@/shared/messaging/client';
import { getAppVersion } from '@/shared/lib/version';
import { isAudioDiagnostics } from '@/features/diagnostics/validation';
import { AudioDiagnostics } from '@/features/diagnostics/components/AudioDiagnostics';
import type { DownloadUnavailableReason } from '../../lib/direct-download';
import type { DownloadAttempt } from '../../lib/download-attempt';
import type { HlsRequestFailure } from '../../lib/hls-request';
import { useDownloadAttempt } from '../../hooks/useDownloadAttempt';
import styles from './TrackDownload.module.scss';

const unavailableMessages: Record<DownloadUnavailableReason, string> = {
  'no-track': 'Сначала включите композицию и дождитесь её названия.',
  'track-changed': 'Композиция уже сменилась. Проверьте название и нажмите ещё раз.',
  'no-source': 'Аудиофайл и доступный HLS-плейлист не обнаружены. Обновите вкладку Звука, включите трек и повторите попытку. Если ошибка останется, включите диагностику и скопируйте отчёт.',
  'hls-source': 'На странице обнаружены HLS-плейлисты. Прямой файл текущей композиции не определён; нужна проверка структуры плейлиста.',
  'multiple-sources': 'На странице несколько аудиоисточников. Нужен диагностический отчёт, чтобы определить текущий.',
  'protected-media': 'Обнаружены признаки защищённого воспроизведения. Сохранение такого источника не поддерживается.',
  'stream-source': 'Плеер использует потоковый или blob-источник. Для следующего шага нужен диагностический отчёт.',
  'private-url': 'Источник содержит служебные параметры доступа. Нужен обезличенный диагностический отчёт.',
  'unsupported-source': 'Этот адрес или формат пока не поддерживается. Нужен диагностический отчёт.',
  'bridge-unavailable': 'Не удалось проверить источник. Обновите вкладку Звука и попробуйте снова.',
  'hls-no-source': 'Плейлист этой композиции ещё не обнаружен. Обновите вкладку Звука, включите трек и повторите попытку.',
  'hls-ambiguous': 'Не удалось однозначно связать плейлист с композицией. Переключите трек и попробуйте снова.',
  'hls-private-url': 'Этот адрес или его параметры не входят в поддерживаемую схему HLS. Сохранение не началось.',
  'hls-unsupported': 'Структура этого HLS-потока пока не поддерживается.',
  'hls-request-failed': 'Не удалось прочитать ресурс HLS. Возможны ограничения доступа или сети.',
  'hls-wrapped-key': 'Звук вернул ключ в формате своего плеера. Доступный открытый поток для скачивания не найден.',
  'hls-too-large': 'Файл превышает ограничение памяти 64 МиБ или допустимый размер отдельного ресурса.',
  'hls-cancelled': 'Подготовка отменена: вкладка, фоновый процесс или время ожидания изменились. Можно повторить попытку.',
  'hls-invalid-data': 'Полученные данные не соответствуют поддерживаемому аудиопотоку. Файл не сохранён.',
};

function requestMessage(request: HlsRequestFailure): string {
  const resources = { manifest: 'плейлиста', init: 'начального фрагмента', segment: 'аудиосегмента', key: 'ключа' };
  const resource = resources[request.resource];
  const status = request.httpStatus === null ? '' : ` (HTTP ${request.httpStatus})`;
  switch (request.kind) {
    case 'http': return `Запрос ${resource} отклонён сервером${status}. Файл не сохранён.`;
    case 'timeout': return `Истекло время ожидания ${resource}${status}. Подготовка остановлена.`;
    case 'network': return request.httpStatus === null
      ? `Браузер не получил доступного ответа для ${resource}. Возможна ошибка сети или ограничение CORS.`
      : `Не удалось дочитать ответ для ${resource}${status}.`;
    case 'empty-body': return `Получен пустой ответ для ${resource}${status}. Файл не сохранён.`;
    case 'invalid-data': return `Не удалось обработать данные ${resource}${status}. Файл не сохранён.`;
  }
}

function unavailableMessage(reason: DownloadUnavailableReason, request?: HlsRequestFailure): string {
  return request && (reason === 'hls-request-failed' || reason === 'hls-invalid-data')
    ? requestMessage(request)
    : unavailableMessages[reason];
}

function attemptMessage(attempt: DownloadAttempt): string {
  if (attempt.reason === 'native-start-failed') return `Chrome не начал скачивание. Код: ${attempt.nativeError ?? 'NATIVE_ERROR'}. Проверьте окно сохранения и список загрузок браузера.`;
  if (attempt.reason === 'native-download-failed') return `Загрузка в Chrome прервана. Код: ${attempt.nativeError ?? 'NATIVE_ERROR'}. Подробности есть в списке загрузок браузера.`;
  if (attempt.reason) return unavailableMessage(attempt.reason, attempt.request);
  switch (attempt.phase) {
    case 'checking': return 'Проверяем связь с вкладкой Звука…';
    case 'preparing': return 'Подготавливаем аудиофайл…';
    case 'starting': return 'Файл подготовлен. Подтвердите сохранение в окне Chrome.';
    case 'started': return 'Скачивание передано Chrome. Статус доступен в списке загрузок браузера.';
    case 'complete': return 'Файл сохранён. Он доступен в списке загрузок браузера.';
    case 'cancelled': return 'Подготовка отменена. Можно повторить попытку.';
    case 'failed': return 'Скачивание не началось. Скопируйте диагностику для проверки.';
  }
}

export function TrackDownload() {
  const source = usePlayerStore(selectCurrentSource);
  const phase = usePlayerStore((state) => state.phase);
  const diagnostic = usePlayerStore((state) => state.diagnostics.find((item) => item.tabId === source?.tabId));
  const attempt = useDownloadAttempt(source?.tabId);
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ key: string; message: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ tabId: number; message: string } | null>(null);
  const [hasDownloadsError, setHasDownloadsError] = useState(false);
  const canUseSource = phase === 'ready' && source?.connection === 'connected';
  const trackKey = JSON.stringify([source?.tabId, source?.track?.id, source?.track?.title, source?.track?.artist, source?.track?.album]);
  const currentFeedback = feedback?.key === trackKey ? feedback : null;
  const isAttemptActive = attempt?.phase === 'checking' || attempt?.phase === 'preparing' || attempt?.phase === 'starting';
  const isBusy = isPending || isAttemptActive;
  const attemptKey = attempt ? JSON.stringify([attempt.tabId, attempt.track.id, attempt.track.title, attempt.track.artist, attempt.track.album]) : null;
  const isPreviousTrack = attempt !== null && attemptKey !== trackKey;
  const message = isPending && !isAttemptActive ? 'Проверяем связь с вкладкой Звука…'
    : attempt ? attemptMessage(attempt) : currentFeedback?.message;
  const showRecorderWithError = canUseSource && !isPreviousTrack && attempt?.reason === 'hls-wrapped-key';
  const recorderLink = <Button variant="ghost" className={styles['track-download__secondary']} asChild>
    <a href="./recorder.html" target="_blank" rel="noreferrer">Записать звук вкладки <ArrowUpRight aria-hidden="true" /></a>
  </Button>;

  async function handleDownload() {
    if (!source?.track || !canUseSource || isBusy) return;
    const { tabId, track } = source;
    setIsPending(true); setFeedback(null); setCopyFeedback(null); setHasDownloadsError(false);
    try {
      const response = await sendExtensionMessage({ type: 'DOWNLOAD_TRACK', tabId, track });
      const message = response.type === 'DOWNLOAD_STARTED' ? 'Скачивание передано Chrome. Статус доступен в списке загрузок браузера.'
        : response.type === 'DOWNLOAD_UNAVAILABLE' ? unavailableMessage(response.reason, response.request)
          : 'Не удалось начать скачивание. Обновите вкладку и попробуйте снова.';
      setFeedback({ key: trackKey, message });
    } catch { setFeedback({ key: trackKey, message: 'Скачивание не началось или было отменено. Можно попробовать снова.' }); }
    finally { setIsPending(false); }
  }
  async function copyDiagnostics() {
    if (!source) return;
    // Only the bounded status and public text fields; never copy artwork, media URLs or request errors.
    const publicText = (value: string | null) => value?.replace(/(?:https?:\/\/|blob:|data:)\S+/gi, '[адрес скрыт]') ?? null;
    const report = {
      version: 3, extensionVersion: getAppVersion(), connection: source?.connection ?? 'no-tab',
      tabPresent: Boolean(source), trackFound: Boolean(source?.track),
      diagnostics: { isEnabled: diagnostic?.isEnabled ?? false, updatedAt: diagnostic?.updatedAt ?? null,
        report: isAudioDiagnostics(diagnostic?.report) ? diagnostic.report : null },
      attempt: attempt ? {
        phase: attempt.phase, reason: attempt.reason, nativeError: attempt.nativeError,
        request: attempt.request ?? null,
        progress: attempt.progress, updatedAt: attempt.updatedAt, downloadId: attempt.downloadId,
        track: { id: attempt.track.id, title: publicText(attempt.track.title), artist: publicText(attempt.track.artist), album: publicText(attempt.track.album) },
      } : null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopyFeedback({ tabId: source.tabId, message: 'Диагностика скопирована' });
    } catch {
      setCopyFeedback({ tabId: source.tabId, message: 'Не удалось скопировать. Разрешите доступ к буферу для окна расширения.' });
    }
  }

  async function openDownloads() {
    setHasDownloadsError(false);
    try { await chrome.tabs.create({ url: 'chrome://downloads/' }); }
    catch { setHasDownloadsError(true); }
  }

  if (!source) return null;

  return (
    <section className={styles['track-download']} aria-label="Сохранение трека">
      {source.track && canUseSource ? <Button className={styles['track-download__primary']} aria-disabled={isBusy} onClick={() => { void handleDownload(); }}>
          {isBusy ? <LoaderCircle aria-hidden="true" className={styles['track-download__spinner']} /> : <Download aria-hidden="true" />}
          {isBusy ? 'Готовим файл…' : 'Скачать песню'}
      </Button> : null}
      {source.track?.url && canUseSource ? <Button variant="ghost" className={styles['track-download__secondary']} asChild>
        <a href={source.track.url} target="_blank" rel="noreferrer">Открыть композицию <ArrowUpRight aria-hidden="true" /></a>
      </Button> : source.track && canUseSource ? <p className={styles['track-download__note']}>ID и ссылка не определены однозначно</p> : null}
      {isAttemptActive ? <Progress value={attempt.progress} aria-label="Подготовка аудиофайла" className={styles['track-download__progress']} /> : null}
      {isPreviousTrack ? <p className={styles['track-download__note']}>Последняя попытка: {attempt.track.title} — {attempt.track.artist}</p> : null}
      <p className={styles['track-download__note']} role="status">{message}</p>
      {showRecorderWithError ? recorderLink : null}
      {attempt && attempt.downloadId !== null ? <Button variant="ghost" className={styles['track-download__secondary']} onClick={() => { void openDownloads(); }}>Открыть загрузки</Button> : null}
      {hasDownloadsError ? <p className={styles['track-download__note']} role="alert">Не удалось открыть загрузки Chrome.</p> : null}
      <Disclosure label="Дополнительные действия">
        {canUseSource && !showRecorderWithError ? recorderLink : null}
        <AudioDiagnostics key={source.tabId} canToggle={canUseSource} />
        <Button variant="ghost" className={styles['track-download__secondary']} onClick={() => { void copyDiagnostics(); }}>
          <Copy aria-hidden="true" />Копировать диагностику
        </Button>
        <p className={styles['track-download__note']} role="status">{copyFeedback?.tabId === source.tabId ? copyFeedback.message : null}</p>
      </Disclosure>
    </section>
  );
}
