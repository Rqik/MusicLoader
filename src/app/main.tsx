import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { App } from './App';

document.documentElement.dataset.surface = window.location.protocol === 'chrome-extension:' ? 'popup' : 'preview';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент popup.');

createRoot(root).render(<StrictMode><App /></StrictMode>);
