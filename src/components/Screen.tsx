'use client';

/**
 * The frame every screen sits in.
 *
 * One column, capped at a comfortable reading width, with the bottom padding
 * that keeps the last card clear of the fixed tab bar. The top padding takes the
 * safe area inset so the title clears the notch when the app is launched
 * standalone from the home screen, where there is no browser chrome to do it.
 */

import type { ReactNode } from 'react';

export function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col px-5"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 1.25rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 6rem)',
      }}
    >
      <header className="mb-5 px-1">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-fg-faint">
          rageflow
        </p>
        <h1 className="mt-1 text-[1.75rem] font-semibold leading-tight tracking-tight text-fg">
          {title}
        </h1>
        {subtitle !== undefined && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
      </header>
      {/* Grows to fill the viewport so the disclaimer, which is `mt-auto`, sits
          at the bottom on a short screen instead of floating in the middle of
          one. On a long screen it flows after the content as normal. */}
      <div className="flex flex-1 flex-col gap-4">{children}</div>
    </main>
  );
}

/**
 * What is on screen between the first paint and the first read of the database.
 *
 * Shaped like the cards it is standing in for rather than a spinner, so opening
 * the app does not flash a different layout before settling into the real one.
 */
export function LoadingScreen({ title }: { title: string }) {
  return (
    <Screen title={title}>
      <div className="h-36 animate-pulse rounded-3xl bg-surface-raised" aria-hidden />
      <div className="h-44 animate-pulse rounded-3xl bg-surface-raised" aria-hidden />
      <p className="sr-only" role="status">
        Loading your history.
      </p>
    </Screen>
  );
}

/**
 * The database could not be opened.
 *
 * This says nothing about her history being gone, because it is not known to be:
 * a private-browsing window and a locked profile both land here with the data
 * still on disk. Offering to clear anything from this screen would be the one
 * action that could turn a failed read into a real loss.
 */
export function LoadErrorScreen({ title, message }: { title: string; message: string }) {
  return (
    <Screen title={title}>
      <section className="rounded-3xl border border-line bg-surface p-5">
        <h2 className="text-lg font-semibold text-danger">Your history could not be opened</h2>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{message}</p>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Nothing has been changed. This can happen in a private browsing window, where the app is
          not allowed to store anything. Try opening rageflow in a normal window, or reload.
        </p>
      </section>
    </Screen>
  );
}
