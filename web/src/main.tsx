import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import { shouldUseHashRouter } from './utils/url';

if (typeof window !== 'undefined') {
  window.__HAPPYCLAW_HASH_ROUTER__ = shouldUseHashRouter();
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // Avoid stale PWA cache/service worker causing dev UI to hang after backend/API changes.
  window.addEventListener('load', () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
    }
    if ('caches' in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => {});
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
