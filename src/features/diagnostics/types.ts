import type { HlsDiscovery } from '../downloads/lib/hls-discovery';

export type AudioFormat = 'mp3' | 'aac' | 'flac' | 'ogg' | 'opus' | 'wav' | 'mp4';
export type AudioDelivery = 'file' | 'hls' | 'dash' | 'segments' | 'blob';

// Только ограниченные признаки. Адреса ресурсов и сведения об авторизации не покидают страницу.
export interface AudioDiagnostics {
  formats: AudioFormat[];
  delivery: AudioDelivery[];
  hasMediaKeys: boolean;
  hasEncryptedEvent: boolean;
  resourceCount: number;
  quality: null;
  mimeTypes: string[];
  hlsDiscovery?: HlsDiscovery;
}

export interface ResourceHints {
  format: AudioFormat | null;
  delivery: AudioDelivery | null;
  mimeType: string | null;
}
