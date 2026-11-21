import { usePlayerStore, selectCurrentSource } from '@/features/player/store/usePlayerStore';
import './AppStatus.scss';
export function AppStatus() {
  const phase = usePlayerStore((state) => state.phase);
  const source = usePlayerStore(selectCurrentSource);
  const label = phase === 'preview' ? 'Предпросмотр' : phase === 'loading' ? 'Проверяем связь…'
    : phase === 'error' || source?.connection === 'error' ? 'Ошибка связи' : !source ? 'Звук не открыт'
    : source.connection === 'waiting' ? 'Обновите вкладку Звука' : 'Звук подключён';
  return (
    <footer className="app-status">
      <span className={`app-status__connection app-status__connection--${source?.connection ?? phase}`} role="status"><span className="app-status__dot" aria-hidden="true" />{label}</span>
    </footer>
  );
}
