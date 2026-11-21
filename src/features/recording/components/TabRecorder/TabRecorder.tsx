import { useEffect, useRef, useState } from 'react';
import { AudioLines, Download, Square } from 'lucide-react';
import { Disclosure } from '@/components/Disclosure/Disclosure';
import { Button } from '@/components/ui/button';
import { recordTabAudio, RecordingError, type RecordingFailure } from '../../record-tab-audio';
import styles from './TabRecorder.module.scss';

type Phase = 'idle' | 'choosing' | 'recording' | 'finishing';
type Clip = { url: string; filename: string };
type Session = { controller: AbortController; stop?: () => void };

const errorMessages: Record<RecordingFailure, string> = {
  unsupported: 'Запись WebM/Opus доступна в Chrome.',
  'selection-denied': 'Доступ к вкладке не предоставлен.',
  'wrong-surface': 'Выберите вкладку Chrome в окне выбора источника.',
  'no-audio': 'Chrome не передал звук. При выборе вкладки включите «Поделиться аудио вкладки».',
  empty: 'Chrome не передал аудиоданные. Запустите воспроизведение и попробуйте снова.',
  'too-large': 'Размер записи превысил 64 МиБ. Попробуйте записать более короткий фрагмент.',
  'capture-failed': 'Chrome не смог записать звук вкладки.',
};
const phaseMessages: Record<Exclude<Phase, 'idle'>, string> = {
  choosing: 'Выберите вкладку Звука в окне Chrome',
  recording: 'Запись идёт. Включите трек и вернитесь сюда, чтобы остановить запись.',
  finishing: 'Подготавливаем аудиофайл…',
};

export function TabRecorder() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [clip, setClip] = useState<Clip | null>(null);
  const [message, setMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const session = useRef<Session | null>(null);
  const clipUrl = useRef<string | null>(null);
  const primaryAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function abortCapture() { session.current?.controller.abort(); }
    window.addEventListener('pagehide', abortCapture);
    return () => {
      window.removeEventListener('pagehide', abortCapture);
      abortCapture();
      session.current = null;
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
      clipUrl.current = null;
    };
  }, []);

  async function start() {
    if (session.current || isSaving) return;
    const current: Session = { controller: new AbortController() };
    session.current = current;
    setMessage('');
    setPhase('choosing');
    try {
      const result = await recordTabAudio(current.controller.signal, (stop) => {
        current.stop = stop;
        setPhase('recording');
      });
      if (current.controller.signal.aborted) return;
      const url = URL.createObjectURL(result.blob);
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
      clipUrl.current = url;
      const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
      setClip({ url, filename: `MusicLoader/Запись вкладки ${stamp}.webm` });
      setMessage(result.hasReachedTimeLimit ? 'Запись остановилась через 15 минут. Файл готов.' : 'Запись готова');
    } catch (error) {
      if (!current.controller.signal.aborted) {
        setMessage(errorMessages[error instanceof RecordingError ? error.code : 'capture-failed']);
      }
    } finally {
      if (session.current === current) {
        session.current = null;
        setPhase('idle');
      }
    }
  }

  function stop() {
    setPhase('finishing');
    session.current?.stop?.();
  }

  async function save() {
    if (!clip || isSaving) return;
    setIsSaving(true);
    try {
      await chrome.downloads.download({ ...clip, saveAs: true, conflictAction: 'uniquify' });
      setMessage('Запись передана в загрузки Chrome');
    } catch {
      setMessage('Chrome не сохранил запись. Можно повторить сохранение.');
    } finally {
      setIsSaving(false);
    }
  }

  const buttonLabel = phase === 'recording' ? 'Остановить запись' : phase === 'choosing' ? 'Выбор вкладки…'
    : phase === 'finishing' ? 'Готовим запись…' : isSaving ? 'Сохраняем запись…' : clip ? 'Сохранить WebM' : 'Начать запись';

  function handlePrimaryAction() {
    if (phase === 'recording') stop();
    else if (phase === 'idle' && !isSaving) {
      if (clip) void save();
      else void start();
    }
  }

  return (
    <main className={styles['tab-recorder']}>
      <div className={styles['tab-recorder__panel']}>
        <header className={styles['tab-recorder__heading']}>
          <span className={styles['tab-recorder__brand']}><AudioLines aria-hidden="true" />MusicLoader</span>
          <h1 className={styles['tab-recorder__title']}>Запись звука вкладки</h1>
          {!clip && phase === 'idle' ? <p>Поставьте трек на паузу перед началом записи.</p> : null}
        </header>
        <div className={styles['tab-recorder__body']}>
          <p role="status" className={styles['tab-recorder__status']}>{phase === 'idle' ? message : phaseMessages[phase]}</p>
          {clip && phase === 'idle' ? <audio className={styles['tab-recorder__preview']} src={clip.url} controls preload="metadata" aria-label="Прослушать запись" /> : null}
          <div className={styles['tab-recorder__actions']}>
            <Button ref={primaryAction} aria-disabled={phase === 'choosing' || phase === 'finishing' || isSaving} onClick={handlePrimaryAction}>
              {phase === 'recording' ? <Square aria-hidden="true" /> : clip && phase === 'idle' ? <Download aria-hidden="true" /> : null}
              {buttonLabel}
            </Button>
            {clip && phase === 'idle' ? <Button variant="ghost" aria-disabled={isSaving} onClick={() => {
              if (isSaving) return;
              primaryAction.current?.focus();
              void start();
            }}>Новая запись</Button> : null}
          </div>
          <Disclosure label="Как выбрать вкладку">
            <ol className={styles['tab-recorder__steps']}>
              <li>Нажмите «Начать запись» и выберите вкладку Chrome со Звуком.</li>
              <li>Включите «Поделиться аудио вкладки» и подтвердите выбор.</li>
              <li>Запустите трек и вернитесь сюда, чтобы остановить запись.</li>
            </ol>
          </Disclosure>
          <p className={styles['tab-recorder__note']}>WebM/Opus · до 15 минут. Сохраните запись перед закрытием вкладки.</p>
        </div>
      </div>
    </main>
  );
}
