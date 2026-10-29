import { AudioLines, ArrowUpRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import './AppHeader.scss';

export function AppHeader() {
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo"><AudioLines size={23} aria-hidden="true" /></span>
        <div>
          <h1 className="app-header__title">MusicLoader<span className="app-header__dot">.</span></h1>
          <p className="app-header__caption">Твоя музыка. Твой ритм.</p>
        </div>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="О демонстрации" className="app-header__info">
            <Info size={18} />
          </Button>
        </DialogTrigger>
        <DialogContent className="app-header__dialog">
          <DialogHeader>
            <DialogTitle>Знакомься, MusicLoader</DialogTitle>
            <DialogDescription>Небольшое пространство для твоей музыкальной коллекции. Пока — в демонстрационном режиме.</DialogDescription>
          </DialogHeader>
          <div className="app-header__details">
            <p>Переключай вымышленные треки, добавляй их в очередь и наблюдай за прогрессом. Ошибку можно исправить кнопкой повтора.</p>
            <p>Файлы не скачиваются. Музыка не воспроизводится. Демо работает, пока открыто это окно; при повторном открытии очередь сбрасывается.</p>
            <p>На сайте Звука расширение проверяет связь со вкладкой. Данные о музыке и API сервиса пока не используются.</p>
          </div>
          <Button variant="secondary" asChild>
            <a href="https://zvuk.com/" target="_blank" rel="noreferrer">Открыть Звук <ArrowUpRight size={16} /></a>
          </Button>
          <span className="app-header__version">Учебный проект · версия 0.1.0</span>
        </DialogContent>
      </Dialog>
    </header>
  );
}
