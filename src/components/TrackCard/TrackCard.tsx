import { useState } from 'react';
import { ArrowUpRight, Music2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePlayerStore, selectCurrentSource } from '@/features/player/store/usePlayerStore';
import styles from './TrackCard.module.scss';

export function TrackCard() {
  const source = usePlayerStore(selectCurrentSource);
  const phase = usePlayerStore((state) => state.phase);
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  const track = source?.track;
  const hasError = phase === 'error' || source?.connection === 'error';
  const canOpenZvuk = !source && (phase === 'ready' || phase === 'preview');
  const playbackLabel = source?.playbackState === 'playing' ? 'Воспроизводится'
    : source?.playbackState === 'paused' ? 'Пауза' : null;
  const emptyTitle = hasError ? 'Не удалось получить данные' : phase === 'loading' ? 'Подключаемся к плееру…'
    : !source ? 'Откройте Звук' : 'Ожидание метаданных';
  const emptyDescription = hasError ? 'Обновите вкладку Звука и откройте расширение снова.'
    : phase === 'preview' ? 'Реальные данные доступны после установки расширения в Chrome.'
    : source?.connection === 'waiting' ? 'Обновите вкладку Звука после установки расширения.' : 'Включите композицию на zvuk.com.';
  return (
    <section className={styles['track-card']} aria-label="Плеер Звука">
      {track && !hasError ? <div className={styles['track-card__heading']}>
        <span>Текущий трек</span>
        {playbackLabel ? <span>{playbackLabel}</span> : null}
      </div> : null}
      <div className={styles['track-card__track']} aria-live="polite">
        {!hasError && track ? track.artwork && failedArtwork !== track.artwork
          ? <img className={styles['track-card__artwork']} src={track.artwork} alt="Обложка альбома" width={64} height={64} referrerPolicy="no-referrer" onError={() => setFailedArtwork(track.artwork)} />
          : <span className={styles['track-card__placeholder']}><Music2 size={24} aria-hidden="true" /></span> : null}
        <div className={styles['track-card__metadata']}>
          <h2 className={styles['track-card__title']}>{hasError ? emptyTitle : track?.title ?? emptyTitle}</h2>
          {hasError || !track ? <p className={styles['track-card__artist']}>{emptyDescription}</p> : <>
            {track.artist ? <p className={styles['track-card__artist']}>{track.artist}</p> : null}
            {track.album ? <p className={styles['track-card__album']}>{track.album}</p> : null}
          </>}
        </div>
      </div>
      {canOpenZvuk ? <Button className={styles['track-card__primary']} asChild>
        <a href="https://zvuk.com/" target="_blank" rel="noreferrer">Открыть Звук <ArrowUpRight aria-hidden="true" /></a>
      </Button> : null}
    </section>
  );
}
