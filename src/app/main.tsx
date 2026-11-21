import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { App } from './App';

const isExtensionPage = window.location.protocol === 'chrome-extension:';
const isActionPopup = isExtensionPage && chrome.extension.getViews({ type: 'popup' }).includes(window);
document.documentElement.dataset.surface = isActionPopup ? 'popup' : isExtensionPage ? 'tab' : 'preview';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент popup.');

createRoot(root).render(<StrictMode><App /></StrictMode>);
