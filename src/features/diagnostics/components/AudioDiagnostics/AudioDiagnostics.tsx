import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePlayerStore, selectCurrentSource } from '@/features/player/store/usePlayerStore';
import { sendExtensionMessage } from '@/shared/messaging/client';
import styles from './AudioDiagnostics.module.scss';
export function AudioDiagnostics({ canToggle }: { canToggle: boolean }) {
  const source = usePlayerStore(selectCurrentSource);
  const diagnostic = usePlayerStore((state) => state.diagnostics.find((item) => item.tabId === source?.tabId));
  const [isPending, setIsPending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const report = diagnostic?.report;
  async function toggle() {
    if (!source || !canToggle || isPending) return;
    setIsPending(true); setHasError(false);
    try { await sendExtensionMessage({ type: 'SET_DIAGNOSTICS', tabId: source.tabId, isEnabled: !diagnostic?.isEnabled }); }
    catch { setHasError(true); }
    finally { setIsPending(false); }
  }
  return (
    <section className={styles['audio-diagnostics']} aria-label="Диагностика аудио">
      <div className={styles['audio-diagnostics__header']}>
        <h3 className={styles['audio-diagnostics__title']}>Диагностика аудио</h3>
        <Button size="sm" variant="outline" disabled={!canToggle} aria-disabled={isPending} onClick={() => { void toggle(); }}>{diagnostic?.isEnabled ? 'Выключить' : 'Включить'}</Button>
      </div>
      {hasError ? <p className={styles['audio-diagnostics__note']} role="alert">Не удалось изменить диагностику.</p> : null}
      {diagnostic?.isEnabled ? <div className={styles['audio-diagnostics__report']} role="status">
        <p>Признаки формата: {report?.formats.length ? report.formats.join(', ').toUpperCase() : 'не определены'}</p>
        <p>MIME: {report?.mimeTypes.length ? report.mimeTypes.join(', ') : 'не доступен'}</p>
        <p>Доставка: {report?.delivery.length ? report.delivery.join(', ') : 'не определена'}</p>
        <p>EME/DRM: {report?.hasMediaKeys || report?.hasEncryptedEvent ? 'есть признаки EME; система DRM не определена' : 'признаки не наблюдались; отсутствие DRM не доказано'}</p>
        <p>Качество: достоверно не определено</p>
        <p>Ресурсов с аудиопризнаками: {report?.resourceCount ?? 0}</p>
        {report?.hlsDiscovery ? <>
          <p>Плейлисты HLS: замечено {report.hlsDiscovery.playlistObservations}, сохранено {report.hlsDiscovery.storedPlaylists}, для текущего трека {report.hlsDiscovery.matchingPlaylists}</p>
          <p>Исключено: параметры доступа — {report.hlsDiscovery.rejectedPrivate}, другой CDN — {report.hlsDiscovery.rejectedHost}, другие ограничения — {report.hlsDiscovery.rejectedOther}</p>
        </> : null}
      </div> : <p className={styles['audio-diagnostics__note']}>Признаки формата и способа доставки аудио</p>}
      {diagnostic?.isEnabled ? <p className={styles['audio-diagnostics__note']}>Расширение файла — подсказка, не подтверждение кодека. blob не доказывает MSE. Cross-origin MIME может быть скрыт.</p> : null}
      {diagnostic?.isEnabled && report?.formats.includes('mp4') && (report.delivery.includes('hls') || report.delivery.includes('segments')) ? <p className={styles['audio-diagnostics__note']}>MP4 может быть начальным фрагментом или сегментом потока. Наличие сегментов не подтверждает доступность плейлиста и целого файла композиции.</p> : null}
    </section>
  );
}
