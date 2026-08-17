import { describe, expect, it } from 'vitest';
import {
  addDays,
  addRoundedDays,
  compareDates,
  diffDays,
  formatDate,
  fromDayNumber,
  isValidISODate,
  isWithin,
  maxDate,
  minDate,
  parseDate,
  roundDays,
  sortDates,
  toDayNumber,
  todayLocal,
} from '../date';

describe('validation', () => {
  it('accepts real calendar dates', () => {
    expect(isValidISODate('2024-02-29')).toBe(true);
    expect(isValidISODate('1999-12-31')).toBe(true);
  });

  it('rejects malformed and impossible dates', () => {
    expect(isValidISODate('2023-02-29')).toBe(false);
    expect(isValidISODate('2024-13-01')).toBe(false);
    expect(isValidISODate('2024-00-10')).toBe(false);
    expect(isValidISODate('2024-04-31')).toBe(false);
    expect(isValidISODate('2024-1-1')).toBe(false);
    expect(isValidISODate('2024-01-01T00:00:00Z')).toBe(false);
    expect(isValidISODate(20240101)).toBe(false);
    expect(isValidISODate(undefined)).toBe(false);
  });

  it('throws rather than guessing', () => {
    expect(() => parseDate('2024-02-30')).toThrow(RangeError);
    expect(() => addDays('2024-01-01', 1.5)).toThrow(RangeError);
    expect(() => formatDate({ year: 2024, month: 2, day: 30 })).toThrow(RangeError);
  });

  it('rejects negative calendar fields instead of dropping the sign', () => {
    // A negative month or day used to come back as a perfectly plausible date,
    // which is the one thing this module promises never to do.
    expect(() => formatDate({ year: 2024, month: -3, day: 5 })).toThrow(RangeError);
    expect(() => formatDate({ year: 2024, month: 3, day: -5 })).toThrow(RangeError);
    expect(() => formatDate({ year: -2024, month: 3, day: 5 })).toThrow(RangeError);
  });

  it('rejects out of range months and days', () => {
    expect(() => formatDate({ year: 2024, month: 0, day: 5 })).toThrow(RangeError);
    expect(() => formatDate({ year: 2024, month: 13, day: 5 })).toThrow(RangeError);
    expect(() => formatDate({ year: 2024, month: 3, day: 0 })).toThrow(RangeError);
    expect(() => formatDate({ year: 2024, month: 3, day: 32 })).toThrow(RangeError);
    expect(() => formatDate({ year: 2023, month: 2, day: 29 })).toThrow(RangeError);
    expect(formatDate({ year: 2024, month: 2, day: 29 })).toBe('2024-02-29');
  });
});

describe('parse and format', () => {
  it('round-trips', () => {
    expect(parseDate('2024-03-09')).toEqual({ year: 2024, month: 3, day: 9 });
    expect(formatDate({ year: 2024, month: 3, day: 9 })).toBe('2024-03-09');
    expect(formatDate({ year: 7, month: 1, day: 2 })).toBe('0007-01-02');
  });
});

describe('day numbers', () => {
  it('anchors on the epoch', () => {
    expect(toDayNumber('1970-01-01')).toBe(0);
    expect(toDayNumber('1970-01-02')).toBe(1);
    expect(toDayNumber('1969-12-31')).toBe(-1);
  });

  it('round-trips over a long span including leap years', () => {
    for (let n = -30000; n <= 30000; n += 7) {
      expect(toDayNumber(fromDayNumber(n))).toBe(n);
    }
  });
});

describe('addDays and diffDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2024-01-31', 1)).toBe('2024-02-01');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01');
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
  });

  it('measures signed whole days', () => {
    expect(diffDays('2024-01-01', '2024-01-01')).toBe(0);
    expect(diffDays('2024-01-01', '2024-02-01')).toBe(31);
    expect(diffDays('2024-02-01', '2024-01-01')).toBe(-31);
    expect(diffDays('2024-01-01', '2025-01-01')).toBe(366);
    expect(diffDays('2023-01-01', '2024-01-01')).toBe(365);
  });

  it('is its own inverse', () => {
    for (let offset = -400; offset <= 400; offset += 13) {
      const moved = addDays('2024-06-15', offset);
      expect(diffDays('2024-06-15', moved)).toBe(offset);
    }
  });
});

describe('daylight saving boundaries', () => {
  // These are the dates on which the wall clock jumps in the zones this app is
  // likely to be used from. A cycle length that came out as 27 or 29 days over
  // one of these would be a real bug in a real product.
  const transitions = [
    // United States, spring forward and fall back.
    { name: 'US spring forward', before: '2024-03-09', after: '2024-03-11' },
    { name: 'US fall back', before: '2024-11-02', after: '2024-11-04' },
    // European Union.
    { name: 'EU spring forward', before: '2024-03-30', after: '2024-04-01' },
    { name: 'EU fall back', before: '2024-10-26', after: '2024-10-28' },
    // Southern hemisphere, where the transitions run the other way.
    { name: 'AU fall back', before: '2024-04-06', after: '2024-04-08' },
    { name: 'AU spring forward', before: '2024-10-05', after: '2024-10-07' },
  ];

  for (const { name, before, after } of transitions) {
    it(`spans ${name} exactly`, () => {
      expect(diffDays(before, after)).toBe(2);
      expect(addDays(before, 2)).toBe(after);
      expect(addDays(after, -2)).toBe(before);
    });
  }

  it('keeps a 28 day cycle 28 days long across a transition', () => {
    // 2024-02-26 to 2024-03-25 contains the US transition on 2024-03-10.
    expect(addDays('2024-02-26', 28)).toBe('2024-03-25');
    expect(diffDays('2024-02-26', '2024-03-25')).toBe(28);
    // 2024-10-20 to 2024-11-17 contains both the EU and US autumn transitions.
    expect(addDays('2024-10-20', 28)).toBe('2024-11-17');
    expect(diffDays('2024-10-20', '2024-11-17')).toBe(28);
  });

  it('steps one day at a time across a whole year without drifting', () => {
    let cursor = '2024-01-01';
    for (let i = 0; i < 366; i += 1) {
      cursor = addDays(cursor, 1);
    }
    expect(cursor).toBe('2025-01-01');
  });
});

describe('todayLocal', () => {
  it('reads local calendar fields, not the UTC instant', () => {
    // Late evening local time. Anywhere west of UTC, toISOString() on this
    // instant reports the following day. The whole point of this function is
    // that it does not.
    const lateEvening = new Date(2024, 2, 9, 23, 30, 0);
    expect(todayLocal(lateEvening)).toBe('2024-03-09');
  });

  it('reads the first minute of the day correctly', () => {
    const justAfterMidnight = new Date(2024, 10, 3, 0, 1, 0);
    expect(todayLocal(justAfterMidnight)).toBe('2024-11-03');
  });
});

describe('comparison helpers', () => {
  it('orders dates', () => {
    expect(compareDates('2024-01-01', '2024-01-02')).toBeLessThan(0);
    expect(compareDates('2024-01-02', '2024-01-01')).toBeGreaterThan(0);
    expect(compareDates('2024-01-01', '2024-01-01')).toBe(0);
    expect(minDate('2024-05-01', '2024-01-01')).toBe('2024-01-01');
    expect(maxDate('2024-05-01', '2024-01-01')).toBe('2024-05-01');
  });

  it('treats ranges as inclusive on both ends', () => {
    expect(isWithin('2024-01-01', '2024-01-01', '2024-01-05')).toBe(true);
    expect(isWithin('2024-01-05', '2024-01-01', '2024-01-05')).toBe(true);
    expect(isWithin('2023-12-31', '2024-01-01', '2024-01-05')).toBe(false);
  });

  it('sorts without mutating', () => {
    const input = ['2024-03-01', '2024-01-01', '2024-02-01'];
    expect(sortDates(input)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    expect(input[0]).toBe('2024-03-01');
  });
});

describe('rounding', () => {
  it('rounds half away from zero so early and late are symmetric', () => {
    expect(roundDays(28.4)).toBe(28);
    expect(roundDays(28.5)).toBe(29);
    expect(roundDays(-28.5)).toBe(-29);
    expect(roundDays(-28.4)).toBe(-28);
    expect(() => roundDays(Number.NaN)).toThrow(RangeError);
  });

  it('applies fractional day offsets to a date', () => {
    expect(addRoundedDays('2024-01-01', 28.6)).toBe('2024-01-30');
    expect(addRoundedDays('2024-01-01', -1.5)).toBe('2023-12-30');
  });
});
