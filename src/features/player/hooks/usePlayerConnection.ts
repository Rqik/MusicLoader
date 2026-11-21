import { useEffect } from 'react';
import { isExtensionContext, sendExtensionMessage } from '../../../shared/messaging/client';
import { usePlayerStore } from '../store/usePlayerStore';
import { PLAYER_KEY_PREFIX, DIAGNOSTICS_KEY_PREFIX } from '../types';

export function usePlayerConnection() {
  useEffect(() => {
    if (!isExtensionContext()) { usePlayerStore.setState({ phase: 'preview' }); return; }
    let isCancelled = false;
    let requestId = 0;
    async function refresh() {
      const id = ++requestId;
      try {
        const response = await sendExtensionMessage({ type: 'GET_PLAYER_STATE' });
        if (response.type !== 'PLAYER_STATE') throw new Error('Unexpected response');
        if (!isCancelled && id === requestId) usePlayerStore.getState().setSources(response.sources, response.diagnostics, response.activeTabId);
      } catch {
        if (!isCancelled && id === requestId) usePlayerStore.setState({ phase: 'error' });
      }
    }
    function handleStorage(changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area === 'local' && Object.keys(changes).some((key) => key.startsWith(PLAYER_KEY_PREFIX) || key.startsWith(DIAGNOSTICS_KEY_PREFIX))) void refresh();
    }
    const handleTabs = () => { void refresh(); };
    chrome.storage.onChanged.addListener(handleStorage);
    chrome.tabs.onActivated.addListener(handleTabs);
    chrome.tabs.onUpdated.addListener(handleTabs);
    chrome.tabs.onRemoved.addListener(handleTabs);
    void refresh();
    return () => {
      isCancelled = true;
      chrome.storage.onChanged.removeListener(handleStorage);
      chrome.tabs.onActivated.removeListener(handleTabs);
      chrome.tabs.onUpdated.removeListener(handleTabs);
      chrome.tabs.onRemoved.removeListener(handleTabs);
    };
  }, []);
}
