import { useEffect, useState } from 'react';
import { sendExtensionMessage } from '@/shared/messaging/client';
import { DOWNLOAD_ATTEMPT_PREFIX, isDownloadAttempt, type DownloadAttempt } from '../lib/download-attempt';

export function useDownloadAttempt(tabId: number | undefined): DownloadAttempt | null {
  const [record, setRecord] = useState<{ tabId: number; attempt: DownloadAttempt | null } | null>(null);
  useEffect(() => {
    if (tabId === undefined || typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    let isDisposed = false;
    let revision = 0;
    const key = `${DOWNLOAD_ATTEMPT_PREFIX}${tabId}`;
    function apply(value: unknown) {
      if (isDisposed) return;
      setRecord({ tabId: tabId!, attempt: isDownloadAttempt(value) && value.tabId === tabId ? value : null });
    }
    const handleStorage: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area !== 'local' || !Object.hasOwn(changes, key)) return;
      revision += 1;
      apply(changes[key]?.newValue);
    };
    chrome.storage.onChanged.addListener(handleStorage);
    const initialRevision = revision;
    void sendExtensionMessage({ type: 'GET_DOWNLOAD_STATUS', tabId }).then((response) => {
      if (revision === initialRevision && response.type === 'DOWNLOAD_STATUS') apply(response.attempt);
    }).catch(() => undefined);
    return () => { isDisposed = true; chrome.storage.onChanged.removeListener(handleStorage); };
  }, [tabId]);
  return record && record.tabId === tabId ? record.attempt : null;
}
