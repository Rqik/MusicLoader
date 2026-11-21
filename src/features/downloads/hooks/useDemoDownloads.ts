import { useEffect } from 'react';
import { advanceDemoQueue } from '../services/demo-downloads';

export function useDemoDownloads(isEnabled: boolean) {
  useEffect(() => {
    if (!isEnabled) return;
    const timer = window.setInterval(advanceDemoQueue, 700);
    return () => window.clearInterval(timer);
  }, [isEnabled]);
}
