import { useState } from 'react';
import { Check, Clock3, Plus, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { demoTracks } from '@/shared/lib/demo-tracks';
import { useDownloadStore } from '@/features/downloads/store/useDownloadStore';
import './TrackCard.scss';

export function TrackCard() {
  const [trackIndex, setTrackIndex] = useState(0);
  const track = demoTracks[trackIndex] ?? demoTracks[0];
  const addTask = useDownloadStore((state) => state.addTask);
  const isAdded = useDownloadStore((state) => state.tasks.some((task) => task.id === track.id));

  return (
    <Card className="track-card" aria-labelledby="current-track-title">
      <div className="track-card__heading">
        <span className="track-card__eyebrow"><span className="track-card__indicator" />ДЕМОТРЕК</span>
        <span className="track-card__counter">0{trackIndex + 1}<span> / 0{demoTracks.length}</span></span>
      </div>
      <div className="track-card__track" aria-live="polite">
        <img className="track-card__artwork" src={`./artwork/${track.artwork}.svg`} alt="" width={80} height={80} />
        <div className="track-card__metadata">
          <h2 className="track-card__title" id="current-track-title">{track.title}</h2>
          <p className="track-card__artist">{track.artist}</p>
          <p className="track-card__album">{track.album}</p>
          <div className="track-card__tags">
            <Badge variant="secondary" className="track-card__badge">DEMO</Badge>
            <span className="track-card__duration"><Clock3 size={11} aria-hidden="true" />{track.duration}</span>
          </div>
        </div>
      </div>
      <div className="track-card__actions">
        <Button className="track-card__add" disabled={isAdded} onClick={() => addTask(track)}>
          {isAdded ? <Check size={16} /> : <Plus size={17} />}
          {isAdded ? 'Добавлено в очередь' : 'Добавить в очередь'}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="track-card__next" variant="secondary" size="icon" aria-label="Следующий демотрек" onClick={() => setTrackIndex((index) => (index + 1) % demoTracks.length)}>
              <SkipForward size={17} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Следующий демотрек</TooltipContent>
        </Tooltip>
      </div>
    </Card>
  );
}
