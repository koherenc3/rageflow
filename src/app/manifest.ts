import type { MetadataRoute } from 'next';

/**
 * What makes this installable to a home screen.
 *
 * `display: standalone` is the point of the whole file: launched from the home
 * screen there is no address bar and no browser chrome, which is what makes a
 * daily-use personal app feel like an app rather than a bookmark.
 *
 * The icons are declared `any maskable` because the mark is drawn inside the
 * maskable safe zone, so the same file is correct whether a launcher crops it or
 * not. See `scripts/generate-icons.mjs`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'rageflow',
    short_name: 'rageflow',
    description: 'A private cycle tracker. Your history stays on this device.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#100d10',
    theme_color: '#100d10',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
