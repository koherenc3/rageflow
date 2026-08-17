/**
 * The display helpers, which are the last place a calendar date can be shifted
 * by a day. Every date here is hand-written and obviously synthetic.
 */

import { describe, expect, it } from 'vitest';
import {
  confidenceLabel,
  formatDateRange,
  formatDay,
  formatDayWithWeekday,
  formatDays,
  formatPercent,
  humanizeDates,
  phaseDisplay,
  relativeDays,
  weekdayOf,
} from '../display';
import { analyze, logFromStartDates } from '@/engine';
import type { CyclePhase } from '@/engine/types';

describe('weekdayOf', () => {
  it('names the weekday without going through Date', () => {
    // 2024-01-01 was a Monday, and 1970-01-01 (day number 0) a Thursday.
    expect(weekdayOf('2024-01-01')).toBe('Mon');
    expect(weekdayOf('1970-01-01')).toBe('Thu');
  });

  it('stays right across a leap day', () => {
    expect(weekdayOf('2024-02-28')).toBe('Wed');
    expect(weekdayOf('2024-02-29')).toBe('Thu');
    expect(weekdayOf('2024-03-01')).toBe('Fri');
  });

  it('names the same weekday seven days apart', () => {
    expect(weekdayOf('2024-01-01')).toBe(weekdayOf('2024-01-08'));
  });
});

describe('formatDay', () => {
  it('drops the year when it matches today', () => {
    expect(formatDay('2024-01-01', '2024-06-01')).toBe('1 Jan');
  });

  it('keeps the year when it does not', () => {
    expect(formatDay('2024-01-01', '2025-06-01')).toBe('1 Jan 2024');
  });

  it('keeps the year when there is no today to compare against', () => {
    expect(formatDay('2024-01-01')).toBe('1 Jan 2024');
  });

  it('puts the weekday in front', () => {
    expect(formatDayWithWeekday('2024-01-01', '2024-01-01')).toBe('Mon 1 Jan');
  });
});

describe('formatDateRange', () => {
  it('prints the month once inside one month', () => {
    expect(formatDateRange('2024-01-08', '2024-01-14', '2024-01-01')).toBe('8 - 14 Jan');
  });

  it('prints both months across a boundary', () => {
    expect(formatDateRange('2024-01-28', '2024-02-04', '2024-01-01')).toBe('28 Jan - 4 Feb');
  });

  it('prints both years across one', () => {
    expect(formatDateRange('2024-12-28', '2025-01-04', '2024-01-01')).toBe('28 Dec - 4 Jan 2025');
  });

  it('handles a range of one day', () => {
    expect(formatDateRange('2024-01-08', '2024-01-08', '2024-01-01')).toBe('8 - 8 Jan');
  });
});

describe('relativeDays', () => {
  it('names the near days rather than counting them', () => {
    expect(relativeDays(0)).toBe('today');
    expect(relativeDays(1)).toBe('tomorrow');
    expect(relativeDays(-1)).toBe('yesterday');
  });

  it('counts in both directions', () => {
    expect(relativeDays(6)).toBe('in 6 days');
    expect(relativeDays(-3)).toBe('3 days ago');
  });

  it('does not say "1 days"', () => {
    expect(relativeDays(2)).toBe('in 2 days');
    expect(relativeDays(-2)).toBe('2 days ago');
  });
});

describe('humanizeDates', () => {
  it('respells the dates and moves no other word', () => {
    expect(humanizeDates('Next period most likely around 2024-09-11.', '2024-06-01')).toBe(
      'Next period most likely around 11 Sep.'
    );
  });

  it('respells every date in a sentence', () => {
    expect(humanizeDates('between 2024-01-08 and 2024-01-14, from 2024-01-01', '2024-01-01')).toBe(
      'between 8 Jan and 14 Jan, from 1 Jan'
    );
  });

  it('leaves a run of digits that is not a calendar date alone', () => {
    // 2024-02-31 does not exist. Rewriting it would invent a day.
    expect(humanizeDates('logged as 2024-02-31', '2024-01-01')).toBe('logged as 2024-02-31');
  });

  it('leaves text with no dates in it untouched', () => {
    const text = 'No periods logged yet. This is a population baseline.';
    expect(humanizeDates(text, '2024-01-01')).toBe(text);
  });

  it('claims nothing the engine did not, on every sentence the engine emits', () => {
    // The substitution must not change a word. Blanking every date on both
    // sides leaves two strings that have to be identical.
    const analysis = analyze(logFromStartDates(['2024-01-01', '2024-01-29', '2024-02-26']), {
      today: '2024-03-10',
    });
    const sentences = [
      analysis.prediction.summary,
      analysis.coldStartMessage,
      analysis.calibration.summary,
      analysis.currentPhase?.summary ?? '',
    ];
    for (const sentence of sentences) {
      const blanked = (value: string) => value.replace(/\d{4}-\d{2}-\d{2}|\d+ [A-Z][a-z]{2}/g, '@');
      expect(blanked(humanizeDates(sentence, '2024-03-10'))).toBe(blanked(sentence));
    }
  });
});

describe('phaseDisplay', () => {
  const ALL: readonly CyclePhase[] = [
    'menstrual',
    'predicted-menstrual',
    'follicular',
    'fertile',
    'luteal',
    'premenstrual',
    'late',
    'stale',
  ];

  it('has a label and a tone for every phase the engine can emit', () => {
    for (const phase of ALL) {
      const display = phaseDisplay(phase);
      expect(display.label).not.toBe('');
      expect(display.tone).not.toBe('');
    }
  });

  it('marks a bleed the engine expects as an estimate and a logged one as not', () => {
    // The whole point of the two being separate phases. If these ever agree, a
    // day the engine guessed at is rendering as a day she recorded.
    expect(phaseDisplay('menstrual').isEstimate).toBe(false);
    expect(phaseDisplay('predicted-menstrual').isEstimate).toBe(true);
  });

  it('does not label late or stale as estimates', () => {
    // Both are statements about the log, not guesses about a day.
    expect(phaseDisplay('late').isEstimate).toBe(false);
    expect(phaseDisplay('stale').isEstimate).toBe(false);
  });

  it('gives no two phases the same label', () => {
    const labels = ALL.map((phase) => phaseDisplay(phase).label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('confidenceLabel', () => {
  it('says the population baseline is not personalized', () => {
    expect(confidenceLabel('none')).toBe('Not personalized');
  });

  it('names each remaining tier', () => {
    expect(confidenceLabel('low')).toMatch(/low/i);
    expect(confidenceLabel('moderate')).toMatch(/moderate/i);
    expect(confidenceLabel('high')).toMatch(/high/i);
  });
});

describe('number formatting', () => {
  it('has no percentage for a figure the engine reported as NaN', () => {
    // Calibration reports NaN with no graded predictions. A "0%" there would be
    // a measurement claim nobody made.
    expect(formatPercent(Number.NaN)).toBeUndefined();
    expect(formatDays(Number.NaN)).toBeUndefined();
  });

  it('rounds a percentage to a whole number', () => {
    expect(formatPercent(0.804)).toBe('80%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('rounds days to one decimal place and gets the noun right', () => {
    expect(formatDays(2.34)).toBe('2.3 days');
    expect(formatDays(1)).toBe('1 day');
  });
});
