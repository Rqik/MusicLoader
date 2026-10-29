import { create } from 'zustand';
import { demoTracks } from '../../../shared/lib/demo-tracks';
import type { Track } from '../../../shared/types/track';
import type { DownloadStatus, DownloadTask } from '../types';

interface DownloadState {
  tasks: DownloadTask[];
  isPaused: boolean;
  addTask: (track: Track) => void;
  removeTask: (id: string) => void;
  updateProgress: (id: string, progress: number) => void;
  updateStatus: (id: string, status: DownloadStatus) => void;
  clearCompleted: () => void;
  retryTask: (id: string) => void;
  togglePaused: () => void;
}

const initialTasks: DownloadTask[] = [
  { ...demoTracks[1], progress: 0, status: 'pending', attempts: 0 },
  { ...demoTracks[2], progress: 100, status: 'completed', attempts: 0 },
  { ...demoTracks[3], progress: 42, status: 'error', attempts: 0 },
];

// Store принадлежит только popup. Background и content не импортируют его.
export const useDownloadStore = create<DownloadState>((set) => ({
  tasks: initialTasks,
  isPaused: false,
  addTask: (track) => set((state) => {
    if (state.tasks.some((task) => task.id === track.id)) return state;
    return { tasks: [...state.tasks, { ...track, progress: 0, status: 'pending', attempts: 0 }] };
  }),
  removeTask: (id) => set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),
  updateProgress: (id, progress) => {
    if (!Number.isFinite(progress)) return;
    set((state) => ({
      tasks: state.tasks.map((task) => task.id === id
        ? { ...task, progress: Math.min(100, Math.max(0, progress)) }
        : task),
    }));
  },
  updateStatus: (id, status) => set((state) => ({
    tasks: state.tasks.map((task) => task.id === id
      ? { ...task, status, progress: status === 'completed' ? 100 : status === 'pending' ? 0 : task.progress }
      : task),
  })),
  clearCompleted: () => set((state) => ({ tasks: state.tasks.filter((task) => task.status !== 'completed') })),
  retryTask: (id) => set((state) => ({
    tasks: state.tasks.map((task) => task.id === id && task.status === 'error'
      ? { ...task, progress: 0, status: 'pending', attempts: task.attempts + 1 }
      : task),
  })),
  togglePaused: () => set((state) => ({ isPaused: !state.isPaused })),
}));
