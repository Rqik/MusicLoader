import { useEffect } from 'react';
import { advanceDemoQueue } from '../services/demo-downloads';

export function useDemoDownloads() {
  useEffect(() => {
    const timer = window.setInterval(advanceDemoQueue, 700);
    return () => window.clearInterval(timer);
  }, []);
}
