import { FlaskConical } from 'lucide-react';
import { useExtensionConnection } from '@/shared/hooks/useExtensionConnection';
import './AppStatus.scss';

export function AppStatus() {
  const { status, page } = useExtensionConnection();
  const label = status === 'preview' ? 'Предпросмотр' : status === 'checking' ? 'Проверяем связь…' : status === 'error' ? 'Нет связи с расширением' : page ? 'Связь со Звуком есть' : 'Расширение подключено';

  return (
    <footer className="app-status">
      <div className="app-status__row">
        <span className={`app-status__connection app-status__connection--${status}`} title={page ? `${page.title} · ${page.origin}` : label} role="status"><span className="app-status__dot" />{label}</span>
        <span className="app-status__demo"><FlaskConical size={11} aria-hidden="true" />Демо-режим</span>
      </div>
      <p className="app-status__note">Без скачивания файлов · работает, пока окно открыто</p>
    </footer>
  );
}
