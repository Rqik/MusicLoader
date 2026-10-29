import { isExtensionResponse, type ExtensionMessage, type ExtensionResponse } from './messages';

export function isExtensionContext() {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

export async function sendExtensionMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  if (!isExtensionContext()) throw new Error('Chrome APIs доступны внутри расширения.');
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isExtensionResponse(response)) throw new Error('Получен неизвестный ответ расширения.');
  if (response.type === 'ERROR') throw new Error(response.message);
  return response;
}
