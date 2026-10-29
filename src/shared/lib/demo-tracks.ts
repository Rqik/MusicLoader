import type { Track } from '../types/track';

// Вымышленные композиции: это данные интерфейса, а не каталог сервиса.
export const demoTracks = [
  { id: 'warm-light', title: 'Тёплый свет', artist: 'Маяк', album: 'Маленькие открытия', duration: '3:42', artwork: 'sunrise' },
  { id: 'after-rain', title: 'После дождя', artist: 'Северный берег', album: 'Вне времени', duration: '4:08', artwork: 'rain' },
  { id: 'quiet-city', title: 'Тихий город', artist: 'Линии', album: 'Наедине', duration: '2:56', artwork: 'city' },
  { id: 'own-wave', title: 'На своей волне', artist: 'Лето внутри', album: 'Без спешки', duration: '3:18', artwork: 'wave' },
] as const satisfies readonly Track[];
