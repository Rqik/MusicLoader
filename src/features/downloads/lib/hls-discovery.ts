export interface HlsDiscovery {
  observerMode: 'observer' | 'history';
  observations: number;
  playlistObservations: number;
  acceptedObservations: number;
  storedPlaylists: number;
  matchingPlaylists: number;
  rejectedPrivate: number;
  rejectedHost: number;
  rejectedOther: number;
}

const counterLimits = {
  observations: 10_000, playlistObservations: 10_000, acceptedObservations: 10_000,
  storedPlaylists: 32, matchingPlaylists: 8,
  rejectedPrivate: 10_000, rejectedHost: 10_000, rejectedOther: 10_000,
} as const;
const fields = ['observerMode', ...Object.keys(counterLimits)];

/** A bounded summary only: resource addresses and arbitrary page data are never accepted. */
export function isHlsDiscovery(value: unknown): value is HlsDiscovery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Reflect.ownKeys(item).length === fields.length && fields.every((field) => Object.hasOwn(item, field))
    && (item.observerMode === 'observer' || item.observerMode === 'history')
    && Object.entries(counterLimits).every(([field, limit]) => typeof item[field] === 'number'
      && Number.isInteger(item[field]) && Number(item[field]) >= 0 && Number(item[field]) <= limit);
}
