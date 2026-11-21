export interface HlsRequestFailure {
  resource: 'manifest' | 'init' | 'segment' | 'key';
  kind: 'http' | 'network' | 'timeout' | 'empty-body' | 'invalid-data';
  httpStatus: number | null;
}

const resources: readonly HlsRequestFailure['resource'][] = ['manifest', 'init', 'segment', 'key'];
const kinds: readonly HlsRequestFailure['kind'][] = ['http', 'network', 'timeout', 'empty-body', 'invalid-data'];

/** Only bounded request metadata may leave MAIN; URLs, headers and error strings never do. */
export function isHlsRequestFailure(value: unknown): value is HlsRequestFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Reflect.ownKeys(item).length === 3 && ['resource', 'kind', 'httpStatus'].every((key) => Object.hasOwn(item, key))
    && resources.some((resource) => resource === item.resource) && kinds.some((kind) => kind === item.kind)
    && (item.httpStatus === null || typeof item.httpStatus === 'number' && Number.isInteger(item.httpStatus)
      && item.httpStatus >= 100 && item.httpStatus <= 599);
}
