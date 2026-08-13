import { describe, expect, it, vi } from 'vitest';
import { analyze, logFromStartDates } from '../index';
import { addDays, compareDates, todayLocal } from '../date';
import { current, late } from './support';
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
    const prediction = current(analysis.prediction);
    expect(prediction.pointDate).toBeDefined();
    expect(prediction.interval50.range.start).toBeDefined();
    expect(prediction.interval80.range.start).toBeDefined();
    expect(prediction.summary).toContain(prediction.interval50.range.start);
    expect(prediction.summary).toContain(prediction.interval80.range.end);
  });

  it('nests the point estimate inside both intervals, and 50 inside 80', () => {
    const { interval50, interval80, pointDate } = current(analysis.prediction);
    expect(compareDates(interval50.range.start, pointDate)).toBeLessThanOrEqual(0);
    expect(compareDates(pointDate, interval50.range.end)).toBeLessThanOrEqual(0);
    expect(compareDates(interval80.range.start, interval50.range.start)).toBeLessThanOrEqual(0);
    expect(compareDates(interval50.range.end, interval80.range.end)).toBeLessThanOrEqual(0);
    expect(interval50.widthDays).toBeLessThan(interval80.widthDays);
  });

  it('anchors the prediction on the most recent logged start', () => {
    expect(analysis.prediction.lastStartDate).toBe('2024-05-20');
    expect(current(analysis.prediction).pointDate).toBe(
      addDays('2024-05-20', Math.round(analysis.prediction.expectedCycleLengthDays))
    );
  });

  it('labels the two intervals with their nominal levels', () => {
    expect(current(analysis.prediction).interval50.level).toBe(0.5);
    expect(current(analysis.prediction).interval80.level).toBe(0.8);
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

/** Days of silence after the last logged start before the log counts as stale. */
function firstStaleGap(starts: readonly string[]): number {
  const lastStart = starts[starts.length - 1] as string;
  for (let gap = 1; gap <= 400; gap += 1) {
    const analysis = analyze(logFromStartDates(starts), { today: addDays(lastStart, gap) });
    if (analysis.prediction.isStale) return gap;
  }
  throw new Error('never went stale within a year');
}

describe('a period that is running late', () => {
  // Predicted start 2024-06-17 for this history, its 80% range ends 2024-06-22,
  // and the staleness bound falls on 2024-07-15, two expected cycle lengths past
  // the last logged start.
  it('does not give up on itself a few days past the prediction', () => {
    // The moment she is most likely to open the app is the moment it used to go
    // blank: the 80% range ended on 2024-06-22, so a six day delay tipped the
    // whole output into the stale state.
    const overdue = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-23' });
    expect(overdue.prediction.isStale).toBe(false);
    expect(overdue.phases.isStale).toBe(false);
    expect(overdue.currentPhase?.phase).toBe('late');
    expect(overdue.currentPhase?.daysLate).toBe(6);
  });

  it('still names a date while its own 80% range has days left in it', () => {
    // Late by the phase model, which counts from the point date, and still a
    // current prediction, which counts from the far end of the range. A period
    // arriving a day or two after the most likely date is the ordinary case the
    // interval exists to describe, so the interval is what decides.
    const day = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-20' });
    expect(day.phases.isLate).toBe(true);
    expect(day.prediction.isLate).toBe(false);
    expect(day.prediction.summary).toMatch(/next period most likely around 2024-06-17/i);
    expect(current(day.prediction).interval80.range.end).toBe('2024-06-22');
  });

  it('stops naming it in the future tense once that range has run out', () => {
    // The same date, still the only date the engine has, but every day it
    // covered is now in the past. "Next period most likely around 2024-06-17" on
    // 2024-06-23 is the smaller version of the months-old date the stale state
    // exists to remove.
    const analysis = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-23' });
    const overdue = late(analysis.prediction);
    expect(overdue.isStale).toBe(false);
    expect(overdue.expectedDate).toBe('2024-06-17');
    expect(overdue.daysLate).toBe(6);
    expect(overdue.summary).not.toMatch(/most likely/i);
    expect(overdue.summary).toMatch(/expected around 2024-06-17, 6 days ago/);
    // The forward-looking dates are gone rather than flagged, for the same
    // reason they are gone from the stale prediction.
    expect(Object.keys(overdue)).not.toContain('pointDate');
    expect(Object.keys(overdue)).not.toContain('interval50');
    expect(Object.keys(overdue)).not.toContain('interval80');
  });

  it('agrees with the phase model about the state of the log', () => {
    // The prediction is drawn later than the phase model on purpose, so the one
    // thing that must never happen is a late prediction beside a phase model
    // that thinks the cycle is running normally.
    const days = ['2024-06-16', '2024-06-17', '2024-06-20', '2024-06-23', '2024-07-15'];
    const states = days.map((today) => analyze(logFromStartDates(REGULAR_STARTS), { today }));
    for (const analysis of states) {
      if (analysis.prediction.isLate) expect(analysis.phases.isLate).toBe(true);
    }
    // And the window where they differ is the one the tiers are cut for, so the
    // check above is not vacuous in either direction.
    expect(states.map((analysis) => analysis.prediction.isLate)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(states.map((analysis) => analysis.phases.isLate)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it('suppresses the fertile window while late, as the stale state does', () => {
    const overdue = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-23' });
    expect(overdue.phases.isLate).toBe(true);
    expect(overdue.phases.daysLate).toBe(6);
    expect(overdue.phases.fertileWindow).toBeUndefined();
    expect(overdue.phases.estimatedOvulationDate).toBeUndefined();
  });

  it('is not late on the predicted day minus one', () => {
    const dayBefore = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-06-16' });
    expect(dayBefore.currentPhase?.phase).not.toBe('late');
    expect(dayBefore.phases.isLate).toBe(false);
    expect(dayBefore.phases.fertileWindow).toBeDefined();
  });
});

describe('a log she stopped keeping', () => {
  // Staleness needs both a far predictive quantile and two elapsed cycle lengths
  // of silence, which for this history puts the bound at 2024-07-15.
  const boundary = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-07-15' });

  it('is still only late on the last day the prediction covers', () => {
    expect(boundary.prediction.isStale).toBe(false);
    expect(boundary.phases.isStale).toBe(false);
    expect(boundary.currentPhase?.phase).toBe('late');
    // Four weeks past the point date by now, and it reads as the date that did
    // not happen rather than as the date the next period is due.
    expect(late(boundary.prediction).expectedDate).toBe('2024-06-17');
    expect(late(boundary.prediction).daysLate).toBe(28);
    expect(boundary.prediction.summary).not.toMatch(/most likely/i);
  });

  it('reports the stale state once today is past that bound', () => {
    const stale = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-07-16' });
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
    expect(stale.currentPhase?.dayOfCycle).toBeUndefined();
    expect(stale.prediction.summary).not.toMatch(/most likely/i);
    expect(stale.prediction.summary).toMatch(/out of date/i);
  });

  it('hands back no dates at all rather than past-dated ones', () => {
    // A boolean beside a still-present pointDate only helps the consumer who
    // remembers to read the boolean.
    const stale = analyze(logFromStartDates(REGULAR_STARTS), { today: '2024-10-01' });
    expect(stale.prediction.isStale).toBe(true);
    expect(Object.keys(stale.prediction)).not.toContain('pointDate');
    expect(Object.keys(stale.prediction)).not.toContain('interval50');
    expect(Object.keys(stale.prediction)).not.toContain('interval80');
    expect(() => current(stale.prediction)).toThrow(/stale/i);
  });

  it('recovers cleanly as soon as she logs again', () => {
    const resumed = analyze(logFromStartDates([...REGULAR_STARTS, '2024-10-01']), {
      today: '2024-10-05',
    });
    expect(resumed.prediction.isStale).toBe(false);
    expect(resumed.phases.isStale).toBe(false);
    expect(resumed.phases.isLate).toBe(false);
    expect(resumed.phases.fertileWindow).toBeDefined();
    expect(resumed.currentPhase?.phase).not.toBe('stale');
    expect(resumed.currentPhase?.dayOfCycle).toBe(5);
  });

  it('needs two expected cycles of silence, not one late period', () => {
    // The floor gate. Without it the bound came off the 80% interval, which the
    // engine's own measured coverage says one normal cycle in ten crosses.
    const lastStart = REGULAR_STARTS[REGULAR_STARTS.length - 1] as string;
    expect(firstStaleGap(REGULAR_STARTS)).toBeGreaterThan(2 * 28 - 1);
    const twoCyclesOn = analyze(logFromStartDates(REGULAR_STARTS), {
      today: addDays(lastStart, 2 * 28 - 1),
    });
    expect(twoCyclesOn.prediction.isStale).toBe(false);
  });

  it('holds on longer for a history it is less sure about', () => {
    // The quantile gate, which is why the bound is not just a multiple of her
    // cycle length: an irregular history has not contradicted itself yet.
    const erratic = [
      '2024-01-01',
      '2024-01-19',
      '2024-03-02',
      '2024-03-20',
      '2024-05-03',
      '2024-05-21',
      '2024-07-04',
      '2024-07-22',
      '2024-09-04',
    ];
    expect(firstStaleGap(erratic)).toBeGreaterThan(firstStaleGap(REGULAR_STARTS));
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
