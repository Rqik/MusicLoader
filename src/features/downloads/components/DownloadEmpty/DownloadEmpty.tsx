import type { DownloadFilter } from '../../types';
import styles from './DownloadEmpty.module.scss';

interface DownloadEmptyProps { filter: DownloadFilter }

export function DownloadEmpty({ filter }: DownloadEmptyProps) {
  return (
    <p className={styles['download-empty']} role="status">
      {filter === 'completed' ? 'Готовых треков пока нет' : filter === 'active' ? 'Очередь пуста' : 'Нет демозагрузок'}
    </p>
  );
}
