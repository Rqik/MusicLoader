import { useState } from 'react';
import { ArrowUpRight, Music2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { usePlayerStore, selectCurrentSource } from '@/features/player/store/usePlayerStore';
import './TrackCard.scss';

export function TrackCard() {
  const source = usePlayerStore(selectCurrentSource);
  const phase = usePlayerStore((state) => state.phase);
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  const track = source?.track;
  const hasError = phase === 'error' || source?.connection === 'error';
  const playbackLabel = source?.playbackState === 'playing' ? 'Воспроизводится'
    : source?.playbackState === 'paused' ? 'Пауза' : null;
  const emptyTitle = hasError ? 'Не удалось получить данные' : phase === 'loading' ? 'Подключаемся к плееру…'
    : !source ? 'Откройте Звук' : 'Ожидание метаданных';
  const emptyDescription = hasError ? 'Обновите вкладку Звука и откройте расширение снова.'
    : phase === 'preview' ? 'Реальные данные доступны после установки расширения в Chrome.'
    : source?.connection === 'waiting' ? 'Обновите вкладку Звука после установки расширения.' : 'Включите композицию на zvuk.com.';
  return (
    <Card className="track-card" aria-labelledby="current-track-title">
      {track ? <CardHeader className="track-card__heading">
        <span>Текущий трек</span>
        {!hasError && playbackLabel ? <span>{playbackLabel}</span> : null}
      </CardHeader> : null}
      <CardContent className="track-card__track" aria-live="polite">
        {track?.artwork && failedArtwork !== track.artwork
          ? <img className="track-card__artwork" src={track.artwork} alt="Обложка альбома" width={96} height={96} referrerPolicy="no-referrer" onError={() => setFailedArtwork(track.artwork)} />
          : track ? <span className="track-card__placeholder"><Music2 size={24} aria-hidden="true" /></span> : null}
        <div className="track-card__metadata">
          <CardTitle className="track-card__title" id="current-track-title" role="heading" aria-level={2}>{hasError ? emptyTitle : track?.title ?? emptyTitle}</CardTitle>
          <p className="track-card__artist">{track ? track.artist || 'Исполнитель не указан' : emptyDescription}</p>
          {track ? <p className="track-card__album">{track.album ?? 'Альбом не указан'}</p> : null}
        </div>
      </CardContent>
      <CardFooter className="track-card__actions">
        {track?.url ? <Button variant="link" className="track-card__link" size="sm" asChild><a href={track.url} target="_blank" rel="noreferrer">Открыть композицию <ArrowUpRight aria-hidden="true" /></a></Button>
          : !track ? <Button size="sm" asChild><a href="https://zvuk.com/" target="_blank" rel="noreferrer">Открыть Звук <ArrowUpRight aria-hidden="true" /></a></Button>
          : <span className="track-card__note">ID и ссылка не определены однозначно</span>}
      </CardFooter>
    </Card>
  );
}
