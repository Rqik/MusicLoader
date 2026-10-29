import { useDownloadStore } from '../store/useDownloadStore';

// Один последовательный исполнитель. Нет сетевых запросов и файловых операций.
export function advanceDemoQueue() {
  const { tasks, isPaused, updateStatus, updateProgress } = useDownloadStore.getState();
  if (isPaused) return;

  const current = tasks.find((task) => task.status === 'downloading');
  if (!current) {
    const next = tasks.find((task) => task.status === 'pending');
    if (next) updateStatus(next.id, 'downloading');
    return;
  }

  const progress = Math.min(current.progress + 14, 100);
  if (current.id === 'own-wave' && current.attempts === 0 && progress >= 42) {
    updateProgress(current.id, 42);
    updateStatus(current.id, 'error');
    return;
  }

  updateProgress(current.id, progress);
  if (progress === 100) updateStatus(current.id, 'completed');
}
