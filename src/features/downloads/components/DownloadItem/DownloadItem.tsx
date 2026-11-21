import { RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDownloadStore } from '../../store/useDownloadStore';
import styles from './DownloadItem.module.scss';

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
    <li className={styles['download-item']} data-status={task.status}>
      <img className={styles['download-item__artwork']} src={`./artwork/${task.artwork}.svg`} alt="" width={40} height={40} />
      <div className={styles['download-item__body']}>
        <h3 className={styles['download-item__title']} title={task.title}>{task.title}</h3>
        <div className={styles['download-item__details']}>
          <p className={styles['download-item__artist']} title={task.artist}>{task.artist}</p>
          <span className={styles['download-item__status']}>{status}{isActive ? ` · ${task.progress}%` : ''}</span>
        </div>
        {isActive ? <Progress value={task.progress} className={styles['download-item__progress']} aria-label={`Прогресс: ${task.title}`} /> : null}
      </div>
      <div className={styles['download-item__actions']}>
        {hasError ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`Повторить: ${task.title}`} onClick={() => retryTask(id)}><RotateCcw aria-hidden="true" /></Button>
            </TooltipTrigger>
            <TooltipContent>Повторить демозагрузку</TooltipContent>
          </Tooltip>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label={`Удалить: ${task.title}`} onClick={() => removeTask(id)}><X aria-hidden="true" /></Button>
      </div>
    </li>
  );
}
