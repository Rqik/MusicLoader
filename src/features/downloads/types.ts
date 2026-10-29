import type { Track } from '../../shared/types/track';

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'error';

export interface DownloadTask extends Track {
  progress: number;
  status: DownloadStatus;
  attempts: number;
}

export type DownloadFilter = 'all' | 'active' | 'completed';
