/**
 * Local calendar date arithmetic.
 *
 * Everything in rageflow is a calendar date, never an instant. "My period
 * started on the 3rd" is a fact about a square on a wall calendar. It has no
 * time zone and no time of day. If we stored it as a `Date` and serialised it
 * we would round-trip it through UTC, and a log made at 11pm would come back as
 * tomorrow. So the canonical representation is the string `YYYY-MM-DD` and all
 * arithmetic here goes through an integer day number, never through `Date`
 * addition. That makes every operation in this file immune to DST, to leap
 * seconds, and to the host time zone.
 *
 * The only place a real `Date` is allowed is {@link todayLocal}, which reads the
 * host clock's *local* calendar fields once and immediately converts to a
 * string.
 */

/** A local calendar date in `YYYY-MM-DD` form. */
export type ISODate = string;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Year, month (1-12), day (1-31) of a calendar date. */
export interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/**
 * The one place a date string is taken apart and checked.
 *
 * Both the predicate and the parser go through this, so validity and the fields
 * come out of a single pass. `toDayNumber` is on the path of every comparison in
 * the engine and those run in loops, so matching twice to answer the same
 * question is worth avoiding.
 */
function calendarPartsOf(value: unknown): CalendarParts | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

/** True when `value` is a syntactically and calendrically valid `YYYY-MM-DD`. */
export function isValidISODate(value: unknown): value is ISODate {
  return calendarPartsOf(value) !== undefined;
}

/** Split a `YYYY-MM-DD` string into its calendar fields. Throws on anything else. */
export function parseDate(date: ISODate): CalendarParts {
  const parts = calendarPartsOf(date);
  if (parts === undefined) {
    throw new RangeError(`Not a valid YYYY-MM-DD calendar date: ${JSON.stringify(date)}`);
  }
  return parts;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Build a `YYYY-MM-DD` string from calendar fields. Throws on impossible dates. */
export function formatDate(parts: CalendarParts): ISODate {
  const { year, month, day } = parts;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new RangeError('Calendar parts must be integers');
  }
  // Every field is range checked before it is padded, which is the whole of the
  // validation: padding a negative number would either drop the sign or produce
  // a string the pattern rejects, and both of those turn a caller's mistake into
  // a plausible looking date. Re-checking the string afterwards would only ask
  // the same three questions of the same three integers.
  if (year < 0 || year > 9999) {
    throw new RangeError(`Year out of supported range: ${year}`);
  }
  if (month < 1 || month > 12) {
    throw new RangeError(`Month out of supported range: ${month}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Day out of supported range for ${year}-${month}: ${day}`);
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian calendar date.
 *
 * Howard Hinnant's `days_from_civil`. Pure integer arithmetic, so it is exact
 * and has no relationship to any clock.
 */
export function toDayNumber(date: ISODate): number {
  const { year, month, day } = parseDate(date);
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of {@link toDayNumber}. Hinnant's `civil_from_days`. */
export function fromDayNumber(dayNumber: number): ISODate {
  if (!Number.isInteger(dayNumber)) {
    throw new RangeError(`Day number must be an integer: ${dayNumber}`);
  }
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return formatDate({ year: y + (month <= 2 ? 1 : 0), month, day });
}

/** `date` shifted by `days` calendar days. Negative values move backwards. */
export function addDays(date: ISODate, days: number): ISODate {
  if (!Number.isInteger(days)) {
    throw new RangeError(`Day offset must be an integer: ${days}`);
  }
  return fromDayNumber(toDayNumber(date) + days);
}

/** Whole calendar days from `from` to `to`. Positive when `to` is later. */
export function diffDays(from: ISODate, to: ISODate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** Standard comparator: negative when `a` is earlier. */
export function compareDates(a: ISODate, b: ISODate): number {
  return toDayNumber(a) - toDayNumber(b);
}

export function isBefore(a: ISODate, b: ISODate): boolean {
  return compareDates(a, b) < 0;
}

export function isAfter(a: ISODate, b: ISODate): boolean {
  return compareDates(a, b) > 0;
}

/** Inclusive on both ends. */
export function isWithin(date: ISODate, start: ISODate, end: ISODate): boolean {
  const n = toDayNumber(date);
  return n >= toDayNumber(start) && n <= toDayNumber(end);
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return compareDates(a, b) <= 0 ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return compareDates(a, b) >= 0 ? a : b;
}

/** Ascending sort. Does not mutate the input. */
export function sortDates(dates: readonly ISODate[]): ISODate[] {
  return [...dates].sort(compareDates);
}

/**
 * The host's current local calendar date.
 *
 * Reads local calendar fields, never `toISOString()`, which would shift the
 * date across midnight for anyone west of UTC.
 */
export function todayLocal(now: Date = new Date()): ISODate {
  return formatDate({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  });
}

/**
 * Round a possibly fractional day count to a whole number of days.
 *
 * Predictions come out of the statistics as real numbers. Every date we hand
 * back has to be a whole day, and we always round half away from zero so a
 * "half day early" and a "half day late" are treated symmetrically.
 */
export function roundDays(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite day count: ${value}`);
  }
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** `date` shifted by a fractional number of days, rounded to a whole day. */
export function addRoundedDays(date: ISODate, days: number): ISODate {
  return addDays(date, roundDays(days));
}
