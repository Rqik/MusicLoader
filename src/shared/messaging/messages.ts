export interface PageContext {
  title: string;
  origin: string;
}

export type ExtensionMessage =
  | { type: 'PING' }
  | { type: 'GET_ACTIVE_PAGE' }
  | { type: 'READ_PAGE_CONTEXT' }
  | { type: 'CONTENT_READY' };

export type ExtensionResponse =
  | { type: 'PONG' }
  | { type: 'ACTIVE_PAGE'; page: PageContext | null }
  | { type: 'PAGE_CONTEXT'; page: PageContext }
  | { type: 'ACK' }
  | { type: 'ERROR'; message: string };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  return value.type === 'PING' || value.type === 'GET_ACTIVE_PAGE'
    || value.type === 'READ_PAGE_CONTEXT' || value.type === 'CONTENT_READY';
}

function isPageContext(value: unknown): value is PageContext {
  return typeof value === 'object' && value !== null
    && 'title' in value && typeof value.title === 'string'
    && 'origin' in value && typeof value.origin === 'string'
    && /^https:\/\/([a-z0-9-]+\.)*zvuk\.com$/.test(value.origin);
}

export function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  switch (value.type) {
    case 'PONG':
    case 'ACK': return true;
    case 'ACTIVE_PAGE': return 'page' in value && (value.page === null || isPageContext(value.page));
    case 'PAGE_CONTEXT': return 'page' in value && isPageContext(value.page);
    case 'ERROR': return 'message' in value && typeof value.message === 'string';
    default: return false;
  }
}
