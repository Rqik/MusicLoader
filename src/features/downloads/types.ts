import type { DemoTrack } from '../../shared/lib/demo-tracks';

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'error';

export interface DownloadTask extends DemoTrack {
  progress: number;
  status: DownloadStatus;
  attempts: number;
}

export type DownloadFilter = 'all' | 'active' | 'completed';
