import type { PlayerSnapshot } from '../types';
export function selectSource(sources: PlayerSnapshot[], activeTabId: number | null): PlayerSnapshot | null {
  const active = sources.find((source) => source.tabId === activeTabId);
  if (active) return active;
  return [...sources].sort((a, b) => Number(b.playbackState === 'playing') - Number(a.playbackState === 'playing')
    || b.updatedAt - a.updatedAt || a.tabId - b.tabId)[0] ?? null;
}
