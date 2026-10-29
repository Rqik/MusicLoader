import { isExtensionMessage, isExtensionResponse, type ExtensionMessage, type ExtensionResponse } from '../../shared/messaging/messages';

async function getActivePage(): Promise<ExtensionResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { type: 'ACTIVE_PAGE', page: null };
  try {
    const response: unknown = await chrome.tabs.sendMessage(tab.id, { type: 'READ_PAGE_CONTEXT' } satisfies ExtensionMessage);
    if (isExtensionResponse(response) && response.type === 'PAGE_CONTEXT') {
      return { type: 'ACTIVE_PAGE', page: response.page };
    }
  } catch {
    // На других сайтах и до перезагрузки вкладки после установки content script отсутствует.
  }
  return { type: 'ACTIVE_PAGE', page: null };
}

// Listener регистрируется сразу при запуске MV3 service worker.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isExtensionMessage(message)) return false;
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' } satisfies ExtensionResponse);
  } else if (message.type === 'CONTENT_READY') {
    sendResponse({ type: 'ACK' } satisfies ExtensionResponse);
  } else if (message.type === 'GET_ACTIVE_PAGE') {
    void getActivePage().then(sendResponse).catch(() => {
      sendResponse({ type: 'ERROR', message: 'Не удалось проверить активную вкладку.' } satisfies ExtensionResponse);
    });
    return true; // Держим канал открытым до завершения асинхронного ответа.
  }
  return false;
});
