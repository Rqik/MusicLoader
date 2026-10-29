import { useEffect, useState } from 'react';
import { isExtensionContext, sendExtensionMessage } from '../messaging/client';
import type { PageContext } from '../messaging/messages';

type ConnectionStatus = 'preview' | 'checking' | 'connected' | 'error';

export function useExtensionConnection() {
  const [status, setStatus] = useState<ConnectionStatus>(isExtensionContext() ? 'checking' : 'preview');
  const [page, setPage] = useState<PageContext | null>(null);

  useEffect(() => {
    if (!isExtensionContext()) return;
    let isCancelled = false;
    async function connect() {
      try {
        const pong = await sendExtensionMessage({ type: 'PING' });
        if (pong.type !== 'PONG') throw new Error('Ожидался PONG');
        const response = await sendExtensionMessage({ type: 'GET_ACTIVE_PAGE' });
        if (response.type !== 'ACTIVE_PAGE') throw new Error('Ожидался ACTIVE_PAGE');
        if (!isCancelled) {
          setPage(response.page);
          setStatus('connected');
        }
      } catch {
        if (!isCancelled) setStatus('error');
      }
    }
    void connect();
    return () => { isCancelled = true; };
  }, []);

  return { status, page };
}
