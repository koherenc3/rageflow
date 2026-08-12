import { describe, expect, it, vi } from 'vitest';
import { analyze, logFromStartDates } from '../index';
import { addDays, compareDates, todayLocal } from '../date';
import type { CycleLog } from '../types';

const REGULAR_STARTS = [
  '2024-01-01',
  '2024-01-29',
  '2024-02-26',
  '2024-03-25',
  '2024-04-22',
  '2024-05-20',
];

describe('logFromStartDates', () => {
  it('produces one period-start entry per date', () => {
    const log = logFromStartDates(['2024-01-01', '2024-01-29']);
    expect(log.version).toBe(1);
    expect(log.entries).toEqual([
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-29', kind: 'period-start' },
    ]);
  });
});

describe('analyze', () => {
  const analysis = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-05' });

  it('reports the day it was asked about', () => {
    expect(analysis.today).toBe('2024-06-05');
  });

  it('defaults to the host local calendar date', () => {
    // The clock is pinned rather than read twice and compared: two independent
    // reads can straddle midnight. Late evening local time, which is the case
    // that breaks if the default ever goes through UTC.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2024, 2, 9, 23, 30, 0));
      expect(analyze({ version: 1, entries: [] }).today).toBe('2024-03-09');
      expect(analyze({ version: 1, entries: [] }).today).toBe(todayLocal());
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives one cycle per logged start', () => {
    expect(analysis.cycles).toHaveLength(REGULAR_STARTS.length);
    expect(analysis.usedCycleCount).toBe(REGULAR_STARTS.length - 1);
  });

  it('never returns a bare date without intervals around it', () => {
    expect(analysis.prediction.pointDate).toBeDefined();
    expect(analysis.prediction.interval50.range.start).toBeDefined();
    expect(analysis.prediction.interval80.range.start).toBeDefined();
    expect(analysis.prediction.summary).toContain(analysis.prediction.interval50.range.start);
    expect(analysis.prediction.summary).toContain(analysis.prediction.interval80.range.end);
  });

  it('nests the point estimate inside both intervals, and 50 inside 80', () => {
    const { interval50, interval80, pointDate } = analysis.prediction;
    expect(compareDates(interval50.range.start, pointDate)).toBeLessThanOrEqual(0);
    expect(compareDates(pointDate, interval50.range.end)).toBeLessThanOrEqual(0);
    expect(compareDates(interval80.range.start, interval50.range.start)).toBeLessThanOrEqual(0);
    expect(compareDates(interval50.range.end, interval80.range.end)).toBeLessThanOrEqual(0);
    expect(interval50.widthDays).toBeLessThan(interval80.widthDays);
  });

  it('anchors the prediction on the most recent logged start', () => {
    expect(analysis.prediction.lastStartDate).toBe('2024-05-20');
    expect(analysis.prediction.pointDate).toBe(
      addDays('2024-05-20', Math.round(analysis.prediction.expectedCycleLengthDays))
    );
  });

  it('labels the two intervals with their nominal levels', () => {
    expect(analysis.prediction.interval50.level).toBe(0.5);
    expect(analysis.prediction.interval80.level).toBe(0.8);
  });

  it('exposes phase, calibration, flags, and cold start together', () => {
    expect(analysis.currentPhase).toBeDefined();
    expect(analysis.calibration.sampleCount).toBe(REGULAR_STARTS.length - 1);
    expect(analysis.clinicalNotes).toEqual([]);
    expect(analysis.missedLogSuspicions).toEqual([]);
    expect(analysis.coldStartMessage).toMatch(/5 cycles/);
  });

  it('gives every fertility output the not-contraception flag', () => {
    expect(analysis.phases.fertilityIsEstimateNotContraception).toBe(true);
    expect(analysis.currentPhase?.fertilityIsEstimateNotContraception).toBe(true);
  });

  it('does not care what order the entries arrive in', () => {
    const shuffled: CycleLog = {
      version: 1,
      entries: [...REGULAR_STARTS].reverse().map((date) => ({ date, kind: 'period-start' })),
    };
    expect(analyze(shuffled, { today: '2024-06-05' }).prediction).toEqual(analysis.prediction);
  });

  it('is a pure function of its inputs', () => {
    const again = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-05' });
    expect(again).toEqual(analysis);
  });

  it('leaves the log untouched', () => {
    const log = logFromStartDates(REGULAR_STARTS);
    const before = JSON.stringify(log);
    analyze(log, { today: '2024-06-05' });
    expect(JSON.stringify(log)).toBe(before);
  });
});

describe('a log she stopped keeping', () => {
  // The 80% range for this history runs out on 2024-06-22. Everything below is
  // stated against that bound rather than a day count, because the bound is the
  // model's own claim about when the next period arrives.
  const boundary = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-22' });

  it('behaves normally right up to the last day the prediction covers', () => {
    expect(boundary.prediction.interval80.range.end).toBe('2024-06-22');
    expect(boundary.prediction.isStale).toBe(false);
    expect(boundary.prediction.summary).toMatch(/next period most likely/i);
    expect(boundary.phases.isStale).toBe(false);
    expect(boundary.phases.fertileWindow).toBeDefined();
    expect(boundary.currentPhase?.phase).toBe('menstrual');
  });

  it('reports the stale state once today is past that bound', () => {
    const stale = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-23' });
    expect(stale.currentPhase?.phase).toBe('stale');
    expect(stale.prediction.isStale).toBe(true);
  });

  it('shows no fertile window and no ovulation estimate months later', () => {
    const stale = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-10-01' });
    expect(stale.phases.isStale).toBe(true);
    expect(stale.phases.fertileWindow).toBeUndefined();
    expect(stale.phases.estimatedOvulationDate).toBeUndefined();
    expect(stale.currentPhase?.phase).toBe('stale');
    // The two false statements this replaces: a day count in the hundreds
    // presented as a period, and a "most likely" date months in the past.
    expect(stale.currentPhase?.summary).not.toMatch(/Period\./);
    expect(stale.prediction.summary).not.toMatch(/most likely/i);
    expect(stale.prediction.summary).toMatch(/out of date/i);
  });

  it('recovers cleanly as soon as she logs again', () => {
    const resumed = analyze(logFromStartDates([...REGULAR_STARTS, '2024-10-01']), {
      today: '2024-10-05',
    });
    expect(resumed.prediction.isStale).toBe(false);
    expect(resumed.phases.isStale).toBe(false);
    expect(resumed.phases.fertileWindow).toBeDefined();
    expect(resumed.currentPhase?.phase).not.toBe('stale');
    expect(resumed.currentPhase?.dayOfCycle).toBe(5);
  });

  it('reads differently from never having logged at all', () => {
    // Two different states. The cold start wording is about not being
    // personalized; the stale wording is about being out of date.
    const cold = analyze({ version: 1, entries: [] }, { today: '2024-10-01' });
    const stale = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-10-01' });
    expect(cold.prediction.isStale).toBe(false);
    expect(cold.phases.isStale).toBe(false);
    expect(cold.currentPhase).toBeUndefined();
    expect(cold.coldStartMessage).toMatch(/no periods logged yet/i);
    expect(stale.coldStartMessage).toMatch(/5 cycles/);
    expect(stale.prediction.summary).not.toBe(cold.prediction.summary);
  });
});

describe('forward compatibility of the data model', () => {
  it('ignores entry kinds it does not know about rather than failing', () => {
    const log = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start' },
        // A future release might add this. An older build must not choke.
        { date: '2024-01-03', kind: 'symptom' },
        { date: '2024-01-29', kind: 'period-start' },
      ],
    } as unknown as CycleLog;
    const analysis = analyze(log, { today: '2024-02-01' });
    expect(analysis.usedCycleCount).toBe(1);
  });

  it('carries an open meta bag on entries without interpreting it', () => {
    const log: CycleLog = {
      version: 1,
      entries: [
        { date: '2024-01-01', kind: 'period-start', meta: { source: 'manual', note: 'x' } },
        { date: '2024-01-29', kind: 'period-start' },
      ],
    };
    expect(analyze(log, { today: '2024-02-01' }).usedCycleCount).toBe(1);
    expect(log.entries[0]?.meta).toEqual({ source: 'manual', note: 'x' });
  });
});

describe('the luteal update hook', () => {
  it('sharpens the luteal estimate when observations are supplied', () => {
    const withoutObservations = analyze(logFromStartDates(REGULAR_STARTS), {
      today: '2024-06-05',
    });
    const withObservations = analyze(logFromStartDates(REGULAR_STARTS), {
      today: '2024-06-05',
      lutealObservations: [11, 12, 11, 11],
    });
    expect(withoutObservations.phases.lutealLength.isPrior).toBe(true);
    expect(withObservations.phases.lutealLength.isPrior).toBe(false);
    expect(withObservations.phases.lutealLength.sdDays).toBeLessThan(
      withoutObservations.phases.lutealLength.sdDays
    );
    // A shorter luteal phase moves ovulation later in the cycle.
    expect(
      compareDates(
        withoutObservations.phases.estimatedOvulationDate as string,
        withObservations.phases.estimatedOvulationDate as string
      )
    ).toBeLessThan(0);
  });
});
