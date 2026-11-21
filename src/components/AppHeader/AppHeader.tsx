import { AudioLines, ArrowUpRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { getAppVersion } from '@/shared/lib/version';
import styles from './AppHeader.module.scss';

export function AppHeader() {
  return (
    <header className={styles['app-header']}>
      <div className={styles['app-header__brand']}>
        <span className={styles['app-header__logo']}><AudioLines size={20} aria-hidden="true" /></span>
        <h1 className={styles['app-header__title']}>MusicLoader</h1>
      </div>
      <span className={styles['app-header__caption']}>v{getAppVersion()}</span>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="О расширении" className={styles['app-header__info']}>
            <Info aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent className={styles['app-header__dialog']}>
          <DialogHeader className={styles['app-header__dialog-heading']}>
            <DialogTitle>О MusicLoader</DialogTitle>
            <DialogDescription>Текущий трек Звука, сохранение аудио и диагностика</DialogDescription>
          </DialogHeader>
          <div className={styles['app-header__details']}>
            <p>Карточка показывает трек из активной вкладки Звука. Если Звук открыт в фоне, приоритет у последней вкладки с воспроизведением, затем у последней доступной вкладки.</p>
            <p>Доступный аудиофайл сохраняется через Chrome. Поддерживаемые потоки HLS сохраняются в M4A.</p>
            <p>Диагностика собирается отдельно для каждой вкладки. В отчёт входят форматы и признаки доставки аудио.</p>
          </div>
          <Button variant="secondary" asChild>
            <a href="https://zvuk.com/" target="_blank" rel="noreferrer">Открыть Звук <ArrowUpRight size={16} /></a>
          </Button>
        </DialogContent>
      </Dialog>
    </header>
  );
}
