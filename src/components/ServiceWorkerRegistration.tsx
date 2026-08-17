'use client';

/**
 * Registers the offline shell.
 *
 * Production only. In development the cache would serve yesterday's bundle over
 * the top of a change and turn every edit into a debugging session about the
 * service worker rather than about the edit.
 *
 * A failure here is silent on purpose. The service worker is what makes the app
 * work offline; it is not what makes the app work, and a browser that refuses to
 * register one should get an app that runs online rather than an error.
 */

import { useEffect } from 'react';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    };
    // After load, so registering never competes with the first paint.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
