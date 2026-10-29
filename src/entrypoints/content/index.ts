import { isExtensionMessage, type ExtensionMessage, type ExtensionResponse } from '../../shared/messaging/messages';

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isExtensionMessage(message)) return false;
  if (message.type === 'READ_PAGE_CONTEXT') {
    sendResponse({
      type: 'PAGE_CONTEXT',
      page: { title: document.title, origin: location.origin },
    } satisfies ExtensionResponse);
  }
  return false;
});

// Только проверка связи. Здесь нет парсинга треков и вмешательства в плеер.
void chrome.runtime.sendMessage({ type: 'CONTENT_READY' } satisfies ExtensionMessage).catch(() => {
  // Перезагрузка расширения может прервать сообщение от уже открытой вкладки.
});
