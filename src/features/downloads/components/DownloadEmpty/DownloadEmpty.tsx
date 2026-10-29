import { CheckCheck, ListMusic } from 'lucide-react';
import type { DownloadFilter } from '../../types';
import './DownloadEmpty.scss';

interface DownloadEmptyProps { filter: DownloadFilter }

export function DownloadEmpty({ filter }: DownloadEmptyProps) {
  const isCompleted = filter === 'completed';
  return (
    <div className="download-empty" role="status">
      <span className="download-empty__icon">{isCompleted ? <CheckCheck size={22} /> : <ListMusic size={22} />}</span>
      <p className="download-empty__title">{isCompleted ? 'Готовых треков пока нет' : filter === 'active' ? 'Всё спокойно' : 'Здесь будет твоя музыка'}</p>
      <p className="download-empty__description">{isCompleted ? 'Завершённые демозагрузки появятся здесь.' : 'Добавь демотрек кнопкой выше.'}</p>
    </div>
  );
}
