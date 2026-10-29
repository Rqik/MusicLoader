import { Check, CircleAlert, Clock3, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDownloadStore } from '../../store/useDownloadStore';
import './DownloadItem.scss';

interface DownloadItemProps { id: string }

export function DownloadItem({ id }: DownloadItemProps) {
  const task = useDownloadStore((state) => state.tasks.find((item) => item.id === id));
  const isPaused = useDownloadStore((state) => state.isPaused);
  const removeTask = useDownloadStore((state) => state.removeTask);
  const retryTask = useDownloadStore((state) => state.retryTask);
  if (!task) return null;

  const isActive = task.status === 'downloading';
  const isCompleted = task.status === 'completed';
  const hasError = task.status === 'error';
  const status = isCompleted ? 'Готово' : hasError ? 'Демоошибка' : isPaused ? 'Приостановлено' : isActive ? 'Загрузка' : 'В очереди';

  return (
    <li className={`download-item download-item--${task.status}`}>
      <img className="download-item__artwork" src={`./artwork/${task.artwork}.svg`} alt="" width={40} height={40} />
      <div className="download-item__body">
        <h3 className="download-item__title" title={task.title}>{task.title}</h3>
        <div className="download-item__details">
          <p className="download-item__artist" title={task.artist}>{task.artist}</p>
          <span className="download-item__status">
            {isCompleted ? <Check size={10} /> : hasError ? <CircleAlert size={10} /> : isActive && !isPaused ? <LoaderCircle size={10} className="download-item__spinner" /> : <Clock3 size={10} />}
            {status}{isActive ? ` · ${task.progress}%` : ''}
          </span>
        </div>
        {isActive ? <Progress value={task.progress} className="download-item__progress" aria-label={`Прогресс: ${task.title}`} /> : null}
      </div>
      <div className="download-item__actions">
        {hasError ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" className="download-item__retry" aria-label={`Повторить: ${task.title}`} onClick={() => retryTask(id)}><RotateCcw size={14} /></Button>
            </TooltipTrigger>
            <TooltipContent>Повторить демозагрузку</TooltipContent>
          </Tooltip>
        ) : null}
        <Button size="icon-sm" variant="ghost" className="download-item__remove" aria-label={`Удалить: ${task.title}`} onClick={() => removeTask(id)}><X size={14} /></Button>
      </div>
    </li>
  );
}
