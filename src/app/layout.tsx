import type { Metadata, Viewport } from 'next';
import './globals.css';
import { LogProvider } from '@/lib/log-store';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import { TabBar } from '@/components/TabBar';

export const metadata: Metadata = {
  title: 'rageflow',
  description: 'A private cycle tracker. Your history stays on this device.',
  applicationName: 'rageflow',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'rageflow',
    // The status bar takes its colour from `themeColor` below, which is defined
    // for both schemes. `black-translucent` would force white text over a page
    // that is white in the light scheme.
    statusBarStyle: 'default',
  },
  icons: {
    icon: [{ url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  // This app is one person's private log. There is no reason for it to be in a
  // search index, and every reason for it not to be.
  robots: { index: false, follow: false },
  other: {
    // Next emits the modern `mobile-web-app-capable` for `appleWebApp.capable`.
    // iOS only started honouring the manifest's `display` member in 16.4, and
    // before that this legacy meta was the only thing that made a home-screen
    // launch open standalone instead of in Safari with its chrome. It costs one
    // tag, and being wrong about it means the app does not look installed.
    'apple-mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Not locked to 1: pinch-zoom is an accessibility feature, and nothing here
  // breaks when it is used.
  maximumScale: 5,
  // Lets the layout reach under the notch and the home indicator, which the safe
  // area padding in `Screen` and `TabBar` then accounts for.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#100d10' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <LogProvider>
          {children}
          <TabBar />
        </LogProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
