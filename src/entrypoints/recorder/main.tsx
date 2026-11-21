import { createRoot } from 'react-dom/client';
import { TabRecorder } from '@/features/recording/components/TabRecorder';
import '@/styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент записи.');
createRoot(root).render(<TabRecorder />);
