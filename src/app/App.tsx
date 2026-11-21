import { TooltipProvider } from '@/components/ui/tooltip';
import { AppHeader } from '@/components/AppHeader';
import { TrackCard } from '@/components/TrackCard';
import { AppStatus } from '@/components/AppStatus';
import { DownloadList } from '@/features/downloads/components/DownloadList';
import { useDemoDownloads } from '@/features/downloads/hooks/useDemoDownloads';
import { usePlayerConnection } from '@/features/player/hooks/usePlayerConnection';
import { usePlayerStore, selectIsDemoEnabled } from '@/features/player/store/usePlayerStore';
import { TrackDownload } from '@/features/downloads/components/TrackDownload';
import styles from './App.module.scss';

export function App() {
  const isDemoEnabled = usePlayerStore(selectIsDemoEnabled);
  useDemoDownloads(isDemoEnabled);
  usePlayerConnection();

  return (
    <TooltipProvider delayDuration={350}>
      <div className={styles['app']}>
        <AppHeader />
        <main className={styles['app__main']}>
          <TrackCard />
          {isDemoEnabled ? <DownloadList /> : <TrackDownload />}
        </main>
        <AppStatus />
      </div>
    </TooltipProvider>
  );
}
