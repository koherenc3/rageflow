import { describe, expect, it } from 'vitest';
import {
  clinicalNotes,
  deriveCycles,
  fittableLengths,
  lastStartDate,
  observedPeriodLengths,
} from '../cycles';
import { diffDays } from '../date';
import { analyze, logFromStartDates } from '../index';
import { learnPeriodLength } from '../phases';
import { MAX_FITTABLE_PERIOD_LENGTH_DAYS, PERIOD_PRIOR_MEAN_DAYS } from '../constants';
import { current } from './support';
import type { CycleLog } from '../types';

function startsOnly(dates: readonly string[]): CycleLog {
  return logFromStartDates(dates);
}

/**
 * Derivation reads today for one purpose: deciding which starts have happened.
 * Every fixture here is in the past by this date, so it takes them all. The
 * future-dated case below sets its own.
 */
const AFTER_EVERY_START = '2024-12-31';

describe('deriveCycles', () => {
  it('returns nothing for an empty log', () => {
    const { cycles, missedLogSuspicions } = deriveCycles(
      { version: 1, entries: [] },
      AFTER_EVERY_START
    );
    expect(cycles).toEqual([]);
    expect(missedLogSuspicions).toEqual([]);
    expect(lastStartDate(cycles)).toBeUndefined();
  });

  it('treats a single start as one in-progress cycle with no length', () => {
    const { cycles } = deriveCycles(startsOnly(['2024-01-05']), AFTER_EVERY_START);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.startDate).toBe('2024-01-05');
    expect(cycles[0]?.lengthDays).toBeUndefined();
    expect(cycles[0]?.nextStartDate).toBeUndefined();
    expect(fittableLengths(cycles)).toEqual([]);
  });

  it('derives lengths as the gap between consecutive starts', () => {
    const { cycles } = deriveCycles(
      startsOnly(['2024-01-05', '2024-02-02', '2024-03-02']),
      AFTER_EVERY_START
    );
    expect(cycles.map((cycle) => cycle.lengthDays)).toEqual([28, 29, undefined]);
    expect(fittableLengths(cycles)).toEqual([28, 29]);
  });

  it('sorts and de-duplicates start entries', () => {
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-02-02', kind: 'period-start' },
        { date: '2024-01-05', kind: 'period-start' },
        { date: '2024-02-02', kind: 'period-start' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles.map((cycle) => cycle.startDate)).toEqual(['2024-01-05', '2024-02-02']);
  });

  it('keeps working across a daylight saving transition', () => {
    // 2024-02-26 to 2024-03-25 spans the US spring-forward on 2024-03-10.
    const { cycles } = deriveCycles(startsOnly(['2024-02-26', '2024-03-25']), AFTER_EVERY_START);
    expect(cycles[0]?.lengthDays).toBe(28);
  });

  it('rejects an invalid date in the log', () => {
    const log: CycleLog = { version: 1, entries: [{ date: '2024-02-30', kind: 'period-start' }] };
    expect(() => deriveCycles(log, AFTER_EVERY_START)).toThrow(RangeError);
  });
});

describe('logged end dates', () => {
  it('attaches an end date to the cycle it falls in and measures the bleed inclusively', () => {
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        { date: '2024-01-09', kind: 'period-end' },
        { date: '2024-02-02', kind: 'period-start' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles[0]?.endDate).toBe('2024-01-09');
    expect(cycles[0]?.periodLengthDays).toBe(5);
    expect(cycles[1]?.endDate).toBeUndefined();
    expect(observedPeriodLengths(cycles)).toEqual([5]);
  });

  it('ignores an end date that predates every start', () => {
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2023-12-30', kind: 'period-end' },
        { date: '2024-01-05', kind: 'period-start' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles[0]?.endDate).toBeUndefined();
    expect(observedPeriodLengths(cycles)).toEqual([]);
  });

  it('leaves period length absent when she only logs starts', () => {
    const { cycles } = deriveCycles(startsOnly(['2024-01-05', '2024-02-02']), AFTER_EVERY_START);
    expect(observedPeriodLengths(cycles)).toEqual([]);
  });

  it('fits a long but plausible bleed', () => {
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        // 15 days, the last length still treated as a period rather than a typo.
        { date: '2024-01-19', kind: 'period-end' },
        { date: '2024-02-02', kind: 'period-start' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles[0]?.periodLengthDays).toBe(MAX_FITTABLE_PERIOD_LENGTH_DAYS);
    expect(observedPeriodLengths(cycles)).toEqual([MAX_FITTABLE_PERIOD_LENGTH_DAYS]);
  });

  it('keeps an implausible bleed in her history but out of the fit', () => {
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        // A mistyped end date: 22 days is not a period.
        { date: '2024-01-26', kind: 'period-end' },
        { date: '2024-02-02', kind: 'period-start' },
        { date: '2024-02-06', kind: 'period-end' },
        { date: '2024-03-02', kind: 'period-start' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    // Her own entry survives untouched.
    expect(cycles[0]?.endDate).toBe('2024-01-26');
    expect(cycles[0]?.periodLengthDays).toBe(22);
    // Only the plausible one reaches the fit.
    expect(observedPeriodLengths(cycles)).toEqual([5]);
  });

  it('does not let one mistyped end date redefine the period length', () => {
    const typo = learnPeriodLength(
      observedPeriodLengths(
        deriveCycles(
          {
            version: 1,
            entries: [
              { date: '2024-01-05', kind: 'period-start' },
              { date: '2024-01-26', kind: 'period-end' },
              { date: '2024-02-02', kind: 'period-start' },
            ],
          },
          AFTER_EVERY_START
        ).cycles
      )
    );
    expect(typo.isPrior).toBe(true);
    expect(typo.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
  });
});

describe('a period start dated after today', () => {
  // She backfills 2024-02-26 and types 2025 by mistake, or taps a date picker
  // that opens on the wrong month. Either way the entry names a day nobody has
  // lived through, and every date the engine reports is indexed off the last
  // logged start, so taking it would move the whole model there.
  const log = startsOnly(['2024-01-01', '2024-01-29', '2024-02-26']);

  it('leaves it out of the cycles and says why', () => {
    const { cycles, futureDatedStarts } = deriveCycles(log, '2024-02-01');
    expect(cycles.map((cycle) => cycle.startDate)).toEqual(['2024-01-01', '2024-01-29']);
    expect(futureDatedStarts).toHaveLength(1);
    expect(futureDatedStarts[0]?.date).toBe('2024-02-26');
    expect(futureDatedStarts[0]?.message).toContain('2024-02-26');
    expect(futureDatedStarts[0]?.message).toContain('2024-02-01');
  });

  it('leaves the gap up to it out of the fit as well', () => {
    // Not just absent from the cycle list: a cycle running to a start that has
    // not happened has no length yet, and inventing one would poison the fit.
    const { cycles } = deriveCycles(log, '2024-02-01');
    expect(fittableLengths(cycles)).toEqual([28]);
    expect(lastStartDate(cycles)).toBe('2024-01-29');
  });

  it('counts it, and reports nothing, from the day it arrives', () => {
    const { cycles, futureDatedStarts } = deriveCycles(log, '2024-02-26');
    expect(cycles).toHaveLength(3);
    expect(fittableLengths(cycles)).toEqual([28, 28]);
    expect(futureDatedStarts).toEqual([]);
  });

  it('never anchors the analysis to a day that has not happened', () => {
    // The whole reason for the rule, at the level she would see it. Every date
    // below would otherwise be indexed off 2024-02-26.
    const analysis = analyze(log, { today: '2024-02-01' });
    expect(analysis.futureDatedStarts).toHaveLength(1);
    expect(analysis.phases.menstrualWindow?.start).toBe('2024-01-29');
    expect(analysis.prediction.lastStartDate).toBe('2024-01-29');
    expect(diffDays('2024-02-01', current(analysis.prediction).pointDate)).toBeGreaterThan(0);
    expect(analysis.currentPhase?.dayOfCycle).toBe(diffDays('2024-01-29', '2024-02-01') + 1);
  });

  it('reports nothing for a log that is entirely in the future', () => {
    const { cycles, futureDatedStarts } = deriveCycles(log, '2023-12-31');
    expect(cycles).toEqual([]);
    expect(futureDatedStarts.map((start) => start.date)).toEqual([
      '2024-01-01',
      '2024-01-29',
      '2024-02-26',
    ]);
  });
});

describe('skip detection', () => {
  /** Regular 28 day cycles with one start missing partway through. */
  function logWithMissedStart(): CycleLog {
    return startsOnly([
      '2024-01-01',
      '2024-01-29',
      '2024-02-26',
      '2024-03-25',
      '2024-04-22',
      // 2024-05-20 would be here. It never got logged, so the next entry is
      // 56 days after the previous one.
      '2024-06-17',
      '2024-07-15',
      '2024-08-12',
    ]);
  }

  it('flags a gap that is about two cycles long', () => {
    const { cycles, missedLogSuspicions } = deriveCycles(logWithMissedStart(), AFTER_EVERY_START);
    expect(missedLogSuspicions).toHaveLength(1);
    expect(missedLogSuspicions[0]?.gapDays).toBe(56);
    expect(missedLogSuspicions[0]?.startDate).toBe('2024-04-22');
    expect(missedLogSuspicions[0]?.question).toMatch(/not get logged/i);
    expect(cycles.find((cycle) => cycle.lengthDays === 56)?.suspectedMissedLog).toBe(true);
  });

  it('excludes the flagged gap from the fit', () => {
    const { cycles } = deriveCycles(logWithMissedStart(), AFTER_EVERY_START);
    expect(fittableLengths(cycles)).toEqual([28, 28, 28, 28, 28, 28]);
  });

  it('does not raise a clinical flag on a gap it does not believe', () => {
    const { cycles } = deriveCycles(logWithMissedStart(), AFTER_EVERY_START);
    const suspect = cycles.find((cycle) => cycle.suspectedMissedLog);
    expect(suspect?.clinicalFlags).toEqual([]);
  });

  it('leaves a merely long cycle alone', () => {
    // 44 days for someone whose cycles run about 29. Long, but not double.
    const { cycles, missedLogSuspicions } = deriveCycles(
      startsOnly(['2024-01-01', '2024-01-30', '2024-02-28', '2024-03-28', '2024-05-11']),
      AFTER_EVERY_START
    );
    expect(missedLogSuspicions).toEqual([]);
    expect(fittableLengths(cycles)).toEqual([29, 29, 29, 44]);
  });

  it('does not flag anything until it has enough accepted cycles to judge against', () => {
    // Someone whose cycles genuinely run long. Judging her first gap against the
    // population prior would flag it, and then every gap after it, leaving her
    // with no usable history at all.
    const { cycles, missedLogSuspicions } = deriveCycles(
      startsOnly(['2024-01-01', '2024-02-20', '2024-04-10', '2024-05-30', '2024-07-19']),
      AFTER_EVERY_START
    );
    expect(missedLogSuspicions).toEqual([]);
    expect(fittableLengths(cycles)).toEqual([50, 50, 50, 50]);
  });

  it('judges each gap only against the cycles before it', () => {
    // The 56 day gap comes first, before any accepted history exists, so it is
    // taken at face value rather than flagged with hindsight.
    const { missedLogSuspicions } = deriveCycles(
      startsOnly(['2024-01-01', '2024-02-26', '2024-03-25', '2024-04-22', '2024-05-20']),
      AFTER_EVERY_START
    );
    expect(missedLogSuspicions).toEqual([]);
  });
});

describe('clinical flags', () => {
  it('flags a cycle shorter than 21 days', () => {
    const { cycles } = deriveCycles(startsOnly(['2024-01-01', '2024-01-19']), AFTER_EVERY_START);
    expect(cycles[0]?.clinicalFlags).toEqual(['unusually-short']);
    const notes = clinicalNotes(cycles);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toMatch(/mentioning to a doctor/i);
    expect(notes[0]?.message).toMatch(/not a diagnosis/i);
  });

  it('flags a cycle longer than 45 days', () => {
    const { cycles } = deriveCycles(startsOnly(['2024-01-01', '2024-02-18']), AFTER_EVERY_START);
    expect(cycles[0]?.clinicalFlags).toEqual(['unusually-long']);
    expect(clinicalNotes(cycles)[0]?.flag).toBe('unusually-long');
  });

  it('leaves the boundary values unflagged', () => {
    const { cycles } = deriveCycles(
      startsOnly(['2024-01-01', '2024-01-22', '2024-03-07', '2024-04-04']),
      AFTER_EVERY_START
    );
    expect(cycles[0]?.lengthDays).toBe(21);
    expect(cycles[1]?.lengthDays).toBe(45);
    expect(cycles[0]?.clinicalFlags).toEqual([]);
    expect(cycles[1]?.clinicalFlags).toEqual([]);
  });

  it('never diagnoses', () => {
    const { cycles } = deriveCycles(startsOnly(['2024-01-01', '2024-01-19']), AFTER_EVERY_START);
    for (const note of clinicalNotes(cycles)) {
      expect(note.message).not.toMatch(/PCOS|thyroid|pregnan|disorder|condition|abnormal/i);
      expect(note.message).toMatch(/not a diagnosis/i);
    }
  });
});
