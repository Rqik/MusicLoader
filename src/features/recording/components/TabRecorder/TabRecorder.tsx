import { useEffect, useRef, useState } from 'react';
import { AudioLines, Download, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { recordTabAudio, RecordingError, type RecordingFailure } from '../../record-tab-audio';
import './TabRecorder.scss';

type Phase = 'idle' | 'choosing' | 'recording' | 'finishing';
type Clip = { url: string; filename: string };
type Session = { controller: AbortController; stop?: () => void };

const errorMessages: Record<RecordingFailure, string> = {
  unsupported: 'Запись WebM/Opus доступна в Chrome.',
  'selection-denied': 'Доступ к вкладке не предоставлен.',
  'wrong-surface': 'Выбери вкладку Chrome в окне выбора источника.',
  'no-audio': 'Chrome не передал звук. При выборе вкладки включи «Поделиться аудио вкладки».',
  empty: 'Chrome не передал аудиоданные. Запусти воспроизведение и попробуй снова.',
  'too-large': 'Размер записи превысил 64 МиБ. Попробуй записать более короткий фрагмент.',
  'capture-failed': 'Chrome не смог записать звук вкладки.',
};
const phaseMessages: Record<Exclude<Phase, 'idle'>, string> = {
  choosing: 'Выбери вкладку Звука в окне Chrome',
  recording: 'Запись идёт. Включи трек и вернись сюда, чтобы остановить запись.',
  finishing: 'Подготавливаем аудиофайл…',
};

export function TabRecorder() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [clip, setClip] = useState<Clip | null>(null);
  const [message, setMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const session = useRef<Session | null>(null);
  const clipUrl = useRef<string | null>(null);
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
    if (session.current) return;
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
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
      const url = URL.createObjectURL(result.blob);
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

  return (
    <main className="tab-recorder">
      <Card className="tab-recorder__panel">
        <CardHeader className="tab-recorder__heading">
          <span className="tab-recorder__brand"><AudioLines aria-hidden="true" />MusicLoader</span>
          <h1 className="tab-recorder__title">Запись звука вкладки</h1>
          <p>Поставь трек на паузу в начале. Нажми «Начать запись», выбери вкладку Звука и включи передачу её звука.</p>
        </CardHeader>
        <CardContent className="tab-recorder__body">
          <div className="tab-recorder__actions">
            {phase === 'recording'
              ? <Button onClick={stop}><Square aria-hidden="true" />Остановить запись</Button>
              : <Button variant={clip ? 'outline' : 'default'} disabled={phase !== 'idle' || isSaving} onClick={() => { void start(); }}>
                {clip ? 'Новая запись' : 'Начать запись'}
              </Button>}
            {clip && phase === 'idle' ? <Button disabled={isSaving} onClick={() => { void save(); }}><Download aria-hidden="true" />Сохранить WebM</Button> : null}
          </div>
          <p role="status" className="tab-recorder__status">{phase === 'idle' ? message : phaseMessages[phase]}</p>
          {clip && phase === 'idle' ? <audio className="tab-recorder__preview" src={clip.url} controls preload="metadata" aria-label="Прослушать запись" /> : null}
          <p className="tab-recorder__note">WebM/Opus · до 15 минут. Сохрани запись перед закрытием этой вкладки.</p>
        </CardContent>
      </Card>
    </main>
  );
}
