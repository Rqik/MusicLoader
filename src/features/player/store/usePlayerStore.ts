import { create } from 'zustand';
import type { PlayerSnapshot } from '../types';
import type { DiagnosticsRecord } from '../../diagnostics/validation';
import { selectSource } from '../lib/select-source';

interface PlayerState {
  sources: PlayerSnapshot[];
  diagnostics: DiagnosticsRecord[];
  activeTabId: number | null;
  phase: 'loading' | 'ready' | 'preview' | 'error';
  setSources: (sources: PlayerSnapshot[], diagnostics: DiagnosticsRecord[], activeTabId: number | null) => void;
  setCurrentTrack: (snapshot: PlayerSnapshot) => void;
  clearCurrentTrack: (tabId: number) => void;
}
export const usePlayerStore = create<PlayerState>((set) => ({
  sources: [], diagnostics: [], activeTabId: null, phase: 'loading',
  setSources: (sources, diagnostics, activeTabId) => set({ sources, diagnostics, activeTabId, phase: 'ready' }),
  setCurrentTrack: (snapshot) => set((state) => ({ sources: [...state.sources.filter((source) => source.tabId !== snapshot.tabId), snapshot] })),
  clearCurrentTrack: (tabId) => set((state) => ({ sources: state.sources.filter((source) => source.tabId !== tabId) })),
}));
export const selectCurrentSource = (state: PlayerState) => selectSource(state.sources, state.activeTabId);
export const selectCurrentTrack = (state: PlayerState) => selectCurrentSource(state)?.track ?? null;
export const selectIsConnected = (state: PlayerState) => selectCurrentSource(state)?.connection === 'connected';
export const selectLastUpdated = (state: PlayerState) => selectCurrentSource(state)?.updatedAt ?? null;
export const selectIsDemoEnabled = (state: PlayerState) => state.phase === 'preview' || (state.phase === 'ready' && state.sources.length === 0);
