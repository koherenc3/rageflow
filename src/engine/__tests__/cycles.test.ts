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
import { AFTER_EVERY_START, current } from './support';
import type { CycleLog, DayEntry } from '../types';

function startsOnly(dates: readonly string[]): CycleLog {
  return logFromStartDates(dates);
}

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

  it('leaves an entry whose date is not a calendar date out, and says so', () => {
    // 2024-02-30 is not a day. One unreadable row is not a reason to hand back
    // nothing at all, so it is reported on the same terms as a future-dated
    // start: excluded from the derivation, left in the log, and named.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        { date: '2024-02-30', kind: 'period-start' },
        { date: '2024-02-02', kind: 'period-start' },
        { date: 'yesterday', kind: 'period-end' },
      ],
    };
    const { cycles, invalidEntries } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles.map((cycle) => cycle.startDate)).toEqual(['2024-01-05', '2024-02-02']);
    expect(cycles[0]?.endDate).toBeUndefined();
    expect(invalidEntries.map((entry) => entry.date)).toEqual(['2024-02-30', 'yesterday']);
    expect(invalidEntries.map((entry) => entry.kind)).toEqual(['period-start', 'period-end']);
    expect(invalidEntries[0]?.message).toContain('2024-02-30');
  });

  it('analyses the rest of a log with an unreadable entry in it', () => {
    // The reason the rule exists: one corrupt row in a persisted log used to
    // take the whole analysis down, so she would have seen nothing rather than
    // the history that is perfectly readable.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        { date: '2024-02-30', kind: 'period-start' },
        { date: '2024-02-02', kind: 'period-start' },
      ],
    };
    const analysis = analyze(log, { today: '2024-02-10' });
    expect(analysis.invalidEntries).toHaveLength(1);
    expect(analysis.cycles).toHaveLength(2);
    expect(analysis.prediction.lastStartDate).toBe('2024-02-02');
  });

  it('leaves an end that an unreadable start may own off the last cycle', () => {
    // The same rule the excluded future-dated start gets, on the exclusion that
    // has no date to bound with. She meant to backfill a start on 2024-02-26 and
    // logged its end; the start is unreadable, so nothing in the log says
    // whether it sat before or after 2024-03-01. Attributing that end to the
    // cycle before it invents a bleed she never recorded on it, which is how a
    // future-dated start once produced a 397 day period.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start' },
        { date: '2024-01-29', kind: 'period-start' },
        { date: 'not-a-date', kind: 'period-start' },
        { date: '2024-03-01', kind: 'period-end' },
      ],
    };
    const { cycles, invalidEntries } = deriveCycles(log, AFTER_EVERY_START);
    expect(invalidEntries.map((entry) => entry.date)).toEqual(['not-a-date']);
    expect(cycles).toHaveLength(2);
    expect(cycles[1]?.endDate).toBeUndefined();
    expect(cycles[1]?.periodLengthDays).toBeUndefined();
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([]);
  });

  it('leaves the ends of the cycles after it exactly where she logged them', () => {
    // The reach of that rule. An end she wrote under a start the derivation
    // accepted belongs to that cycle, and an unreadable row earlier in the log
    // is not a reason to take it off her. Nothing in the log suggests this end
    // belongs to the bad row: she logged a start after it and then logged this.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start' },
        { date: 'not-a-date', kind: 'period-start' },
        { date: '2024-02-01', kind: 'period-start' },
        { date: '2024-02-12', kind: 'period-end' },
      ],
    };
    const { cycles, invalidEntries } = deriveCycles(log, AFTER_EVERY_START);
    expect(invalidEntries.map((entry) => entry.date)).toEqual(['not-a-date']);
    expect(cycles[1]?.startDate).toBe('2024-02-01');
    expect(cycles[1]?.endDate).toBe('2024-02-12');
    expect(cycles[1]?.periodLengthDays).toBe(12);
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([12]);
  });

  it('publishes no fertility estimate over the bleed that end records', () => {
    // Why discarding it is not the safe direction. A cycle laid out around a
    // shorter bleed than the one she recorded publishes the fertile window
    // across the difference, which is the estimate over her own entry that the
    // whole layout exists to stop, reached through the derivation instead of the
    // phase layer.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start' },
        { date: 'not-a-date', kind: 'period-start' },
        { date: '2024-02-01', kind: 'period-start' },
        { date: '2024-02-12', kind: 'period-end' },
      ],
    };
    const analysis = analyze(log, { today: '2024-02-12' });
    expect(analysis.phases.menstrualWindow).toEqual({ start: '2024-02-01', end: '2024-02-12' });
    // Not vacuous: this cycle does have a fertile window, and it sits clear of
    // every day her entry names.
    const fertile = analysis.phases.fertileWindow;
    expect(fertile).toBeDefined();
    expect(diffDays('2024-02-12', fertile?.start as string)).toBeGreaterThan(0);
  });

  it('still gives every cycle bounded by a real start the end that falls in it', () => {
    // The reach of that rule. Only the last cycle has no start of its own to
    // stop at, so only it can be handed an end belonging to a start that was
    // left out. One unreadable row must not cost her the ends she logged on the
    // cycles either side of it.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        { date: '2024-01-09', kind: 'period-end' },
        { date: 'not-a-date', kind: 'period-start' },
        { date: '2024-02-02', kind: 'period-start' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles[0]?.endDate).toBe('2024-01-09');
    expect(cycles[0]?.periodLengthDays).toBe(5);
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([5]);
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
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([5]);
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
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([]);
  });

  it('places an end she logged after the next start by its date', () => {
    // The order of the log names the cycle an end was written under, and the
    // date is what places the ends it cannot: this one is dated before the start
    // it follows, so it is a bleed she went back and logged after the fact
    // rather than one of the cycle that had already begun.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-05', kind: 'period-start' },
        { date: '2024-02-02', kind: 'period-start' },
        { date: '2024-01-09', kind: 'period-end' },
      ],
    };
    const { cycles } = deriveCycles(log, AFTER_EVERY_START);
    expect(cycles[0]?.endDate).toBe('2024-01-09');
    expect(cycles[0]?.periodLengthDays).toBe(5);
    expect(cycles[1]?.endDate).toBeUndefined();
  });

  it('leaves period length absent when she only logs starts', () => {
    const { cycles } = deriveCycles(startsOnly(['2024-01-05', '2024-02-02']), AFTER_EVERY_START);
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([]);
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
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([
      MAX_FITTABLE_PERIOD_LENGTH_DAYS,
    ]);
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
    expect(observedPeriodLengths(cycles, AFTER_EVERY_START)).toEqual([5]);
  });

  it('waits for an end dated after today rather than counting days that have not happened', () => {
    // She starts on the 5th, means to log the end as the 5th of the next month
    // and types the 15th of this one, two days out. Three days of bleeding
    // counted as eleven is not an observation. The open cycle is the only one
    // with no next start to bound the search, so an end it cannot have observed
    // yet is left unattributed until the day it names arrives; taking it would
    // let one mistyped date move onto each new last cycle as she logs starts.
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-03-05', kind: 'period-start' },
        { date: '2024-03-15', kind: 'period-end' },
      ],
    };
    const ahead = deriveCycles(log, '2024-03-07').cycles;
    expect(ahead[0]?.endDate).toBeUndefined();
    expect(ahead[0]?.periodLengthDays).toBeUndefined();
    expect(observedPeriodLengths(ahead, '2024-03-07')).toEqual([]);
    // The entry is untouched, and counts from the day it names.
    expect(log.entries).toHaveLength(2);
    const arrived = deriveCycles(log, '2024-03-15').cycles;
    expect(arrived[0]?.endDate).toBe('2024-03-15');
    expect(arrived[0]?.periodLengthDays).toBe(11);
    expect(observedPeriodLengths(arrived, '2024-03-15')).toEqual([11]);
  });

  it('leaves the learned length at the prior rather than biased by that entry', () => {
    const { cycles } = deriveCycles(
      {
        version: 1,
        entries: [
          { date: '2024-03-05', kind: 'period-start' },
          { date: '2024-03-15', kind: 'period-end' },
        ],
      },
      '2024-03-07'
    );
    const learned = learnPeriodLength(observedPeriodLengths(cycles, '2024-03-07'));
    expect(learned.isPrior).toBe(true);
    expect(learned.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
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
        ).cycles,
        AFTER_EVERY_START
      )
    );
    expect(typo.isPrior).toBe(true);
    expect(typo.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
  });
});

describe('an end date mistyped into next year', () => {
  // She means 2024-01-31 and types 2024-12-31. The open cycle is the only one
  // with no next start to stop the end search, so before this rule that entry
  // landed there, and landed there again on each new last cycle as she logged
  // starts: one typo withheld the fertility estimate from every cycle after it
  // rather than from the one she wrote it on. An end naming a day she cannot
  // have observed is simply not attributed, so it has nowhere to migrate to.
  const typed: DayEntry[] = [
    { date: '2024-01-01', kind: 'period-start' },
    { date: '2024-01-29', kind: 'period-start' },
    { date: '2024-12-31', kind: 'period-end' },
  ];

  it('attributes it to no cycle while the day it names is still ahead', () => {
    const analysis = analyze({ version: 1, entries: typed }, { today: '2024-02-10' });
    expect(analysis.cycles.map((cycle) => cycle.endDate)).toEqual([undefined, undefined]);
    // Untouched: still in the log, and reported nowhere as an error.
    expect(analysis.invalidEntries).toEqual([]);
  });

  it('cannot move onto the cycles she opens after it', () => {
    // The containment claim, checked rather than asserted in prose.
    const later: CycleLog = {
      version: 1,
      entries: [
        ...typed,
        { date: '2024-02-26', kind: 'period-start' },
        { date: '2024-03-25', kind: 'period-start' },
      ],
    };
    const analysis = analyze(later, { today: '2024-03-25' });
    expect(analysis.cycles).toHaveLength(4);
    expect(analysis.cycles.map((cycle) => cycle.endDate)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('takes it on the cycle it belongs to once that day has arrived', () => {
    // It is her data, not a permanent exclusion. Read on a day past the one she
    // typed, the end is the bleed of the cycle it falls in.
    const analysis = analyze({ version: 1, entries: typed }, { today: '2025-01-15' });
    expect(analysis.cycles[1]?.endDate).toBe('2024-12-31');
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

  it('leaves the end that belongs to it out with it', () => {
    // She backfills the start with next year's digits and logs its end too. An
    // end date belongs to the start it follows, so excluding the start has to
    // exclude the end: the cycle before it never saw that bleed, and taking the
    // entry onto it produced a 397 day period.
    const withEnd: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start' },
        { date: '2024-01-29', kind: 'period-start' },
        { date: '2025-02-26', kind: 'period-start' },
        { date: '2025-03-01', kind: 'period-end' },
      ],
    };
    const { cycles, futureDatedStarts } = deriveCycles(withEnd, '2024-02-10');
    expect(futureDatedStarts.map((start) => start.date)).toEqual(['2025-02-26']);
    expect(cycles).toHaveLength(2);
    expect(cycles[1]?.endDate).toBeUndefined();
    expect(cycles[1]?.periodLengthDays).toBeUndefined();
    expect(observedPeriodLengths(cycles, '2024-02-10')).toEqual([]);
  });

  it('still takes the end that really does belong to the last counted cycle', () => {
    // The bound is on ends that fall after the excluded start, not on ends in
    // general. Excluding one entry must not cost her the entry beside it.
    const withEnd: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start' },
        { date: '2024-01-29', kind: 'period-start' },
        { date: '2024-02-02', kind: 'period-end' },
        { date: '2025-02-26', kind: 'period-start' },
        { date: '2025-03-01', kind: 'period-end' },
      ],
    };
    const { cycles } = deriveCycles(withEnd, '2024-02-10');
    expect(cycles[1]?.endDate).toBe('2024-02-02');
    expect(cycles[1]?.periodLengthDays).toBe(5);
    expect(observedPeriodLengths(cycles, '2024-02-10')).toEqual([5]);
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
