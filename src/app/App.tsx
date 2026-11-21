import { TooltipProvider } from '@/components/ui/tooltip';
import { AppHeader } from '@/components/AppHeader';
import { TrackCard } from '@/components/TrackCard';
import { AppStatus } from '@/components/AppStatus';
import { DownloadList } from '@/features/downloads/components/DownloadList';
import { useDemoDownloads } from '@/features/downloads/hooks/useDemoDownloads';
import { usePlayerConnection } from '@/features/player/hooks/usePlayerConnection';
import { AudioDiagnostics } from '@/features/diagnostics/components/AudioDiagnostics';
import { usePlayerStore, selectIsDemoEnabled } from '@/features/player/store/usePlayerStore';
import { TrackDownload } from '@/features/downloads/components/TrackDownload';
import './App.scss';

export function App() {
  const isDemoEnabled = usePlayerStore(selectIsDemoEnabled);
  useDemoDownloads(isDemoEnabled);
  usePlayerConnection();

  return (
    <TooltipProvider delayDuration={350}>
      <div className="app">
        <AppHeader />
        <main className="app__main">
          <TrackCard />
          {isDemoEnabled ? <DownloadList /> : <TrackDownload />}
          <AudioDiagnostics />
        </main>
        <AppStatus />
      </div>
    </TooltipProvider>
  );
}
