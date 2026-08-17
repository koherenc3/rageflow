/**
 * Turning engine output into the words and shapes on screen.
 *
 * Two rules run through all of it.
 *
 * There is no `Date` here. A calendar date is formatted by taking it apart with
 * the engine's parser and looking the names up, and the weekday comes out of the
 * day number rather than out of a clock. `new Date('2026-09-11')` parses as UTC
 * midnight and renders as the 10th for anyone west of it, which is exactly the
 * bug the whole date design exists to prevent, and it would appear here at the
 * last step rather than in the engine.
 *
 * Nothing here invents a claim the engine did not make. Where the engine
 * withholds a date, a window, or a number, the corresponding helper has nothing
 * to return, and the caller renders nothing rather than a placeholder.
 */

import { isValidISODate, parseDate, toDayNumber, type ISODate } from '@/engine/date';
import type { ConfidenceTier, CyclePhase } from '@/engine/types';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Day number 0 is 1970-01-01, which was a Thursday. */
const WEEKDAYS = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'] as const;

export function weekdayOf(date: ISODate): string {
  const index = ((toDayNumber(date) % 7) + 7) % 7;
  return WEEKDAYS[index] ?? '';
}

function monthOf(date: ISODate): string {
  return MONTHS[parseDate(date).month - 1] ?? '';
}

export function monthNameLong(month: number): string {
  return MONTHS_LONG[month - 1] ?? '';
}

/** `11 Sep`, with the year appended only when it is not the current one. */
export function formatDay(date: ISODate, today?: ISODate): string {
  const { year, day } = parseDate(date);
  const suffix = today !== undefined && parseDate(today).year === year ? '' : ` ${year}`;
  return `${day} ${monthOf(date)}${suffix}`;
}

/** `Fri 11 Sep`, for the one date on screen that deserves a weekday. */
export function formatDayWithWeekday(date: ISODate, today?: ISODate): string {
  return `${weekdayOf(date)} ${formatDay(date, today)}`;
}

/**
 * `8 - 14 Sep`, or `28 Sep - 4 Oct` across a month boundary.
 *
 * The month is printed once when both ends share it. A range is the honest
 * answer to when her next period is due, so it is the thing on screen that has
 * to read at a glance rather than be decoded.
 */
export function formatDateRange(start: ISODate, end: ISODate, today?: ISODate): string {
  const from = parseDate(start);
  const to = parseDate(end);
  if (from.year === to.year && from.month === to.month) {
    return `${from.day} - ${formatDay(end, today)}`;
  }
  return `${formatDay(start, today)} - ${formatDay(end, today)}`;
}

function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * `today`, `tomorrow`, `in 6 days`, `3 days ago`.
 *
 * Takes a day count rather than two dates, so the caller does the subtraction
 * with the engine's `diffDays` and this stays a wording decision.
 */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${dayCount(days)}` : `${dayCount(-days)} ago`;
}

const ISO_DATE_IN_TEXT = /\d{4}-\d{2}-\d{2}/g;

/**
 * The engine's own sentences, with the dates in them made readable.
 *
 * The engine writes plain sentences a consumer can show verbatim, and they are
 * worth showing verbatim: they are careful about what they claim, and rewriting
 * them here would mean maintaining a second set of claims that can drift from
 * the first. What they are not is pretty, because the engine writes a date the
 * only way it stores one.
 *
 * So this changes how a date is spelled and nothing else. It is a substitution
 * over `YYYY-MM-DD` runs, it validates each one before replacing it, and it
 * leaves anything that is not a real calendar date exactly as it found it. No
 * word of the claim moves.
 */
export function humanizeDates(text: string, today?: ISODate): string {
  return text.replace(ISO_DATE_IN_TEXT, (match) =>
    isValidISODate(match) ? formatDay(match, today) : match
  );
}

export interface PhaseDisplay {
  label: string;
  /** The token suffix in globals.css: `--phase-<tone>`. */
  tone: string;
  /**
   * True where the phase is something the engine expects rather than something
   * she logged. The UI marks these, because a day the engine merely expects must
   * never render as a period she recorded.
   */
  isEstimate: boolean;
}

/**
 * The eight states, exhaustively.
 *
 * The switch has no default, so adding a ninth to the engine's union stops this
 * compiling rather than rendering it as whatever the fallback happened to be.
 */
export function phaseDisplay(phase: CyclePhase): PhaseDisplay {
  switch (phase) {
    case 'menstrual':
      return { label: 'Period', tone: 'menstrual', isEstimate: false };
    case 'predicted-menstrual':
      return { label: 'Period expected', tone: 'menstrual', isEstimate: true };
    case 'follicular':
      return { label: 'Follicular', tone: 'follicular', isEstimate: true };
    case 'fertile':
      return { label: 'Fertile window', tone: 'fertile', isEstimate: true };
    case 'luteal':
      return { label: 'Luteal', tone: 'luteal', isEstimate: true };
    case 'premenstrual':
      return { label: 'Premenstrual', tone: 'premenstrual', isEstimate: true };
    case 'late':
      return { label: 'Late', tone: 'late', isEstimate: false };
    case 'stale':
      return { label: 'Out of date', tone: 'stale', isEstimate: false };
  }
}

/** The word beside the confidence bar. Driven by the engine's tier, never by a threshold here. */
export function confidenceLabel(tier: ConfidenceTier): string {
  switch (tier) {
    case 'none':
      return 'Not personalized';
    case 'low':
      return 'Low confidence';
    case 'moderate':
      return 'Moderate confidence';
    case 'high':
      return 'High confidence';
  }
}

/** A fraction as a whole-number percentage. `NaN` has no percentage, so it has no string. */
export function formatPercent(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return `${Math.round(value * 100)}%`;
}

/** One decimal place, or nothing at all where the engine reported `NaN`. */
export function formatDays(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
}
