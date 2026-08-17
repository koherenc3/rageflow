/**
 * The small set of shapes every screen is built from.
 *
 * There are three of them on purpose. A personal app used once a day should look
 * like one thing, and the way to get that is to have very little to choose
 * between rather than a component for every idea.
 *
 * Tap targets are at least 44px tall, which is Apple's floor and roughly the pad
 * of a thumb. Anything interactive here meets it without the caller having to
 * remember to ask.
 */

import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  tone,
}: {
  children: ReactNode;
  className?: string;
  /** A phase tone from `phaseDisplay`. Tints the card and its left edge. */
  tone?: string;
}) {
  const toned =
    tone === undefined
      ? undefined
      : {
          backgroundColor: `var(--phase-${tone}-soft)`,
          borderColor: `color-mix(in srgb, var(--phase-${tone}) 22%, transparent)`,
        };
  return (
    <section className={`rounded-3xl border border-line bg-surface p-5 ${className}`} style={toned}>
      {children}
    </section>
  );
}

/** The small uppercase line above a block. Never the only thing naming it. */
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-fg-faint">
      {children}
    </h2>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="px-1 text-sm font-semibold text-fg-muted">{children}</h2>;
}

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent border-transparent active:bg-accent-hover disabled:opacity-45',
  secondary: 'bg-surface text-fg border-line-strong active:bg-surface-raised disabled:opacity-45',
  quiet: 'bg-transparent text-fg-muted border-transparent active:bg-surface-raised',
  // The soft fill and the foreground are defined as a pair in both schemes, so
  // this stays legible where a white-on-red button would fail in dark mode.
  danger: 'bg-danger-soft text-danger border-transparent active:opacity-80 disabled:opacity-45',
};

export function Button({
  children,
  variant = 'secondary',
  full = false,
  className = '',
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  full?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex min-h-[3rem] items-center justify-center gap-2 rounded-2xl border px-5 text-base font-semibold transition-colors ${
        BUTTON_STYLES[variant]
      } ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A line of the form "label: value", where an absent value means the whole row
 * is absent.
 *
 * The engine withholds numbers it cannot support, and this is how that reaches
 * the screen: a row with nothing to say does not render as a dash.
 */
export function Stat({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  );
}

/**
 * A calm, non-alarming note. Used for everything the engine merely observes.
 *
 * `alert` is what a screen reader hears, and it is a separate prop rather than a
 * reading of the tone colour so a caller cannot get it silently wrong. A note
 * that reports a failed action sets it: with VoiceOver on, a refused save moves
 * no focus and changes nothing audible, so an unannounced failure reads as a
 * success. Everything else stays quiet, because an observation about her cycle
 * has no business interrupting whatever she is doing.
 */
export function Note({
  children,
  tone = 'stale',
  alert = false,
}: {
  children: ReactNode;
  tone?: 'stale' | 'late' | 'menstrual';
  alert?: boolean;
}) {
  return (
    <p
      className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
      {...(alert ? { role: 'alert' } : {})}
      style={{
        backgroundColor: `var(--phase-${tone}-soft)`,
        color: `var(--phase-${tone})`,
      }}
    >
      {children}
    </p>
  );
}

/**
 * The medical framing, carried on every screen that says anything about a cycle.
 *
 * It is quiet rather than hidden. The app is not contraception and not medical
 * advice, and a line she stops seeing is a line that is not doing its job, so it
 * sits at the end of the screen rather than behind a link.
 */
export function Disclaimer() {
  return (
    <p className="mt-auto px-2 pt-6 text-center text-xs leading-relaxed text-fg-faint">
      Estimates from your logged dates alone. Not contraception, and not medical advice.
    </p>
  );
}
