import { useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDownloadStore } from '../../store/useDownloadStore';
import type { DownloadFilter } from '../../types';
import { DownloadItem } from '../DownloadItem';
import { DownloadEmpty } from '../DownloadEmpty';
import styles from './DownloadList.module.scss';

export function DownloadList() {
  const [filter, setFilter] = useState<DownloadFilter>('all');
  const taskIds = useDownloadStore(useShallow((state) => state.tasks
    .filter((task) => filter === 'all' || (filter === 'completed' ? task.status === 'completed' : task.status !== 'completed'))
    .map((task) => task.id)));
  const total = useDownloadStore((state) => state.tasks.length);
  const completedCount = useDownloadStore((state) => state.tasks.filter((task) => task.status === 'completed').length);
  const hasActiveTasks = useDownloadStore((state) => state.tasks.some((task) => task.status === 'pending' || task.status === 'downloading'));
  const isPaused = useDownloadStore((state) => state.isPaused);
  const togglePaused = useDownloadStore((state) => state.togglePaused);
  const clearCompleted = useDownloadStore((state) => state.clearCompleted);

  function handleFilterChange(value: string) {
    if (value === 'all' || value === 'active' || value === 'completed') setFilter(value);
  }

  return (
    <section className={styles['download-list']} aria-labelledby="queue-title">
      <div className={styles['download-list__heading']}>
        <h2 className={styles['download-list__title']} id="queue-title">Демоочередь</h2>
        <div className={styles['download-list__actions']}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className={styles['download-list__action']} disabled={!hasActiveTasks && !isPaused} aria-label={isPaused ? 'Продолжить очередь' : 'Приостановить очередь'} onClick={togglePaused}>
                {isPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isPaused ? 'Продолжить очередь' : 'Приостановить очередь'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className={styles['download-list__action']} disabled={completedCount === 0} aria-label="Очистить завершённые" onClick={clearCompleted}><Trash2 aria-hidden="true" /></Button>
            </TooltipTrigger>
            <TooltipContent>Очистить завершённые</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Tabs value={filter} onValueChange={handleFilterChange} className={styles['download-list__tabs']}>
        <TabsList className={styles['download-list__filters']} aria-label="Фильтр очереди">
          <TabsTrigger value="all" className={styles['download-list__filter']}>Все</TabsTrigger>
          <TabsTrigger value="active" className={styles['download-list__filter']}>В очереди</TabsTrigger>
          <TabsTrigger value="completed" className={styles['download-list__filter']}>Готово <span className={styles['download-list__filter-count']}>{completedCount}</span></TabsTrigger>
        </TabsList>
        <TabsContent value={filter} className={styles['download-list__content']}>
          {taskIds.length > 0 ? <ul className={styles['download-list__items']}>{taskIds.map((id) => <DownloadItem key={id} id={id} />)}</ul> : <DownloadEmpty filter={filter} />}
        </TabsContent>
      </Tabs>
      <p className={styles['download-list__summary']} role="status">{isPaused ? 'Очередь на паузе' : `${completedCount} из ${total} завершено`}</p>
    </section>
  );
}
