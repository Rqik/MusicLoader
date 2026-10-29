import { TooltipProvider } from '@/components/ui/tooltip';
import { AppHeader } from '@/components/AppHeader';
import { TrackCard } from '@/components/TrackCard';
import { AppStatus } from '@/components/AppStatus';
import { DownloadList } from '@/features/downloads/components/DownloadList';
import { useDemoDownloads } from '@/features/downloads/hooks/useDemoDownloads';
import './App.scss';

export function App() {
  useDemoDownloads();

  return (
    <TooltipProvider delayDuration={350}>
      <div className="app">
        <AppHeader />
        <main className="app__main">
          <TrackCard />
          <DownloadList />
        </main>
        <AppStatus />
      </div>
    </TooltipProvider>
  );
}
