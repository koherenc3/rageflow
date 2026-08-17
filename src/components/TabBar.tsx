'use client';

/**
 * Three tabs, fixed to the bottom.
 *
 * Bottom rather than top because the app is used one-handed on a phone, and the
 * top of a modern iPhone is not somewhere a thumb reaches. The bar sits above
 * the home indicator by padding with the safe area inset rather than a guessed
 * constant, so it is right on every device and in Safari as well as standalone.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Today' },
  { href: '/log', label: 'Log' },
  { href: '/history', label: 'History' },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/85 backdrop-blur-xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex w-full max-w-[26rem] items-stretch">
        {TABS.map((tab) => {
          const current = isCurrent(pathname, tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={current ? 'page' : undefined}
                className={`flex min-h-[3.25rem] items-center justify-center text-[0.9375rem] font-semibold transition-colors ${
                  current ? 'text-accent' : 'text-fg-faint'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
