/**
 * The synthetic fixtures. Each one is a shape of real cycle history with known
 * ground truth, and each asserts the behaviour the engine is supposed to show
 * on it. Every generator is seeded, so a failure here is a real regression and
 * never a flake.
 *
 * Nothing in this file is real data. See docs/TESTING.md.
 */

import { describe, expect, it } from 'vitest';
import { analyze, fitCycleLength, logFromStartDates } from '../index';
import { CLINICAL_LONG_CYCLE_DAYS } from '../constants';
import {
  generateCycleLengths,
  generateDriftingCycleLengths,
  mergeCycleAt,
  startDatesFromLengths,
} from '../testing/synthetic';
import { current } from './support';
import type { CycleAnalysis } from '../types';

const FIRST_START = '2023-02-01';
/** A half life long enough that the fit is effectively unweighted. */
const NO_DECAY_HALF_LIFE = 1e9;

function analyzeLengths(lengths: readonly number[]): CycleAnalysis {
  const starts = startDatesFromLengths(FIRST_START, lengths);
  const today = starts[starts.length - 1] as string;
  return analyze(logFromStartDates(starts), { today });
}

function meanOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe('fixture: regular cycles, mean 28, sd 1', () => {
  const lengths = generateCycleLengths({ count: 14, meanDays: 28, sdDays: 1, seed: 1 });
  const analysis = analyzeLengths(lengths);

  it('learns the true mean', () => {
    expect(analysis.posterior.mu).toBeGreaterThan(27.5);
    expect(analysis.posterior.mu).toBeLessThan(28.5);
  });

  it('keeps the intervals tight', () => {
    expect(current(analysis.prediction).interval50.widthDays).toBeLessThanOrEqual(6);
    expect(current(analysis.prediction).interval80.widthDays).toBeLessThanOrEqual(10);
    expect(current(analysis.prediction).interval50.widthDays).toBeLessThan(
      current(analysis.prediction).interval80.widthDays
    );
  });

  it('has a mean absolute error under 1.5 days from cycle 6 onward', () => {
    const fromSixth = analysis.calibration.records.filter((r) => r.cycleIndex >= 5);
    expect(fromSixth.length).toBeGreaterThan(5);
    expect(meanOf(fromSixth.map((r) => Math.abs(r.errorDays)))).toBeLessThan(1.5);
  });

  it('reports full confidence with this much history', () => {
    expect(analysis.confidenceTier).toBe('high');
    expect(analysis.personalized).toBe(true);
  });

  it('raises no clinical flags and suspects no missed logs', () => {
    expect(analysis.clinicalNotes).toEqual([]);
    expect(analysis.missedLogSuspicions).toEqual([]);
  });
});

describe('fixture: irregular cycles, mean 31, sd 7', () => {
  const lengths = generateCycleLengths({ count: 14, meanDays: 31, sdDays: 7, seed: 2 });
  const analysis = analyzeLengths(lengths);
  const regular = analyzeLengths(
    generateCycleLengths({ count: 14, meanDays: 28, sdDays: 1, seed: 1 })
  );

  it('widens the intervals compared with a regular cycle at the same cycle count', () => {
    expect(current(analysis.prediction).interval80.widthDays).toBeGreaterThan(
      current(regular.prediction).interval80.widthDays
    );
    expect(analysis.posterior.predictive.standardDeviation).toBeGreaterThan(
      regular.posterior.predictive.standardDeviation
    );
  });

  it('reports lower confidence than the regular case despite equal history', () => {
    expect(analysis.confidence).toBeLessThan(regular.confidence);
  });

  it('still covers the truth about as often as it claims', () => {
    // Pooled over several seeded runs, because coverage on a single 14 cycle
    // run is a noisy estimate.
    let inside = 0;
    let total = 0;
    for (let seed = 0; seed < 25; seed += 1) {
      const run = analyzeLengths(
        generateCycleLengths({ count: 14, meanDays: 31, sdDays: 7, seed: 300 + seed })
      );
      for (const r of run.calibration.records) {
        total += 1;
        if (r.within80) inside += 1;
      }
    }
    expect(total).toBeGreaterThan(200);
    expect(inside / total).toBeGreaterThan(0.7);
    expect(inside / total).toBeLessThan(0.95);
  });
});

describe('fixture: drifting mean, 27 rising to 33 over 12 cycles', () => {
  const spec = { count: 12, startMeanDays: 27, endMeanDays: 33, sdDays: 1, seed: 4 } as const;
  const lengths = generateDriftingCycleLengths(spec);

  it('tracks the drift upward rather than averaging the whole history', () => {
    const weighted = fitCycleLength(lengths);
    const unweighted = fitCycleLength(lengths, NO_DECAY_HALF_LIFE);
    const recentTruth = meanOf(lengths.slice(-3));
    expect(weighted.mu).toBeGreaterThan(unweighted.mu);
    expect(Math.abs(recentTruth - weighted.mu)).toBeLessThan(Math.abs(recentTruth - unweighted.mu));
  });

  it('predicts more accurately than an unweighted fit once the drift has set in', () => {
    // Replay both fits over the same history and compare their out-of-sample
    // error on the second half, after the mean has moved. Pooled over seeds,
    // because on a single 12 cycle run the two can tie after rounding to whole
    // days.
    function replayMae(halfLife: number, run: readonly number[]): number {
      const seen: number[] = [];
      const errors: number[] = [];
      for (let i = 0; i < run.length; i += 1) {
        const predicted = Math.round(fitCycleLength(seen, halfLife).predictive.location);
        if (i >= run.length / 2) errors.push(Math.abs((run[i] as number) - predicted));
        seen.push(run[i] as number);
      }
      return meanOf(errors);
    }

    const weighted: number[] = [];
    const unweighted: number[] = [];
    for (let seed = 0; seed < 20; seed += 1) {
      const run = generateDriftingCycleLengths({ ...spec, seed: 700 + seed });
      weighted.push(replayMae(6, run));
      unweighted.push(replayMae(NO_DECAY_HALF_LIFE, run));
    }
    expect(meanOf(weighted)).toBeLessThan(meanOf(unweighted));
  });

  it('holds across seeds, so this is the model and not one lucky run', () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const run = generateDriftingCycleLengths({ ...spec, seed });
      expect(fitCycleLength(run).mu).toBeGreaterThan(fitCycleLength(run, NO_DECAY_HALF_LIFE).mu);
    }
  });

  it('ends up nearer the recent mean than the starting mean', () => {
    const analysis = analyzeLengths(lengths);
    expect(analysis.posterior.mu).toBeGreaterThan(spec.startMeanDays + 2);
  });
});

describe('fixture: two cycles recorded as one because a log was missed', () => {
  const base = generateCycleLengths({ count: 10, meanDays: 28, sdDays: 1.5, seed: 6 });
  const merged = mergeCycleAt(base, 5);
  const clean = analyzeLengths(base);
  const handled = analyzeLengths(merged);
  const naive = fitCycleLength(merged);

  it('flags the merged gap and asks about it', () => {
    expect(handled.missedLogSuspicions).toHaveLength(1);
    const suspicion = handled.missedLogSuspicions[0];
    expect(suspicion?.gapDays).toBe((base[5] as number) + (base[6] as number));
    expect(suspicion?.question).toMatch(/did a period start in between/i);
  });

  it('excludes it from the fit', () => {
    expect(handled.usedCycleCount).toBe(merged.length - 1);
    expect(
      handled.cycles.filter((cycle) => cycle.suspectedMissedLog).map((cycle) => cycle.lengthDays)
    ).toEqual([(base[5] as number) + (base[6] as number)]);
  });

  it('does not let the merged gap poison the variance', () => {
    // Left in the fit, one 60 day gap roughly triples the predictive spread.
    expect(naive.predictive.standardDeviation).toBeGreaterThan(
      2 * clean.posterior.predictive.standardDeviation
    );
    expect(handled.posterior.predictive.standardDeviation).toBeLessThan(
      1.2 * clean.posterior.predictive.standardDeviation
    );
  });

  it('does not let the merged gap drag the mean either', () => {
    expect(Math.abs(naive.mu - clean.posterior.mu)).toBeGreaterThan(2);
    expect(Math.abs(handled.posterior.mu - clean.posterior.mu)).toBeLessThan(0.5);
  });

  it('does not present the gap as a clinically long cycle', () => {
    expect(handled.clinicalNotes).toEqual([]);
  });
});

describe('fixture: long cycles around 45 days', () => {
  const lengths = generateCycleLengths({ count: 10, meanDays: 46, sdDays: 2, seed: 5 });
  const analysis = analyzeLengths(lengths);

  it('flags the cycles over 45 days without diagnosing anything', () => {
    const expected = lengths.filter((length) => length > CLINICAL_LONG_CYCLE_DAYS).length;
    expect(expected).toBeGreaterThan(0);
    expect(analysis.clinicalNotes).toHaveLength(expected);
    for (const note of analysis.clinicalNotes) {
      expect(note.flag).toBe('unusually-long');
      expect(note.message).toMatch(/mentioning to a doctor/i);
      expect(note.message).toMatch(/not a diagnosis/i);
    }
  });

  it('does not mistake genuinely long cycles for missed logs', () => {
    expect(analysis.missedLogSuspicions).toEqual([]);
  });

  it('produces a usable prediction rather than an absurd range', () => {
    expect(current(analysis.prediction).interval80.widthDays).toBeLessThan(25);
    expect(current(analysis.prediction).interval50.widthDays).toBeLessThan(
      current(analysis.prediction).interval80.widthDays
    );
    expect(analysis.posterior.mu).toBeGreaterThan(40);
    expect(analysis.posterior.mu).toBeLessThan(50);
  });

  it('does not crash or produce a non-finite number anywhere', () => {
    expect(Number.isFinite(analysis.posterior.mu)).toBe(true);
    expect(Number.isFinite(analysis.posterior.predictive.scale)).toBe(true);
    expect(Number.isFinite(analysis.posterior.predictive.standardDeviation)).toBe(true);
    expect(Number.isFinite(analysis.confidence)).toBe(true);
  });
});

describe('fixture: fewer than three cycles', () => {
  it('says plainly that nothing is personalized with an empty log', () => {
    const analysis = analyze({ version: 1, entries: [] }, { today: '2024-06-01' });
    expect(analysis.usedCycleCount).toBe(0);
    expect(analysis.confidenceTier).toBe('none');
    expect(analysis.personalized).toBe(false);
    expect(analysis.confidence).toBe(0);
    expect(analysis.coldStartMessage).toMatch(/not personalized/i);
    expect(analysis.coldStartMessage).toMatch(/population baseline/i);
    expect(analysis.prediction.summary).toMatch(/population baseline/i);
    expect(analysis.currentPhase).toBeUndefined();
  });

  it('is still unpersonalized after a single logged start, and says so', () => {
    const analysis = analyze(logFromStartDates(['2024-05-01']), { today: '2024-05-10' });
    expect(analysis.usedCycleCount).toBe(0);
    expect(analysis.personalized).toBe(false);
    expect(analysis.coldStartMessage).toMatch(/only one period logged/i);
    expect(analysis.coldStartMessage).toMatch(/not personalized/i);
    // There is a start to count from, so a phase can still be reported.
    expect(analysis.currentPhase?.dayOfCycle).toBe(10);
  });

  it('gives wide intervals and a low confidence with one or two cycles', () => {
    const lengths = generateCycleLengths({ count: 2, meanDays: 28, sdDays: 1, seed: 7 });
    const analysis = analyzeLengths(lengths);
    expect(analysis.confidenceTier).toBe('low');
    expect(analysis.confidence).toBeLessThan(0.25);
    expect(current(analysis.prediction).interval80.widthDays).toBeGreaterThan(10);
    expect(analysis.coldStartMessage).toMatch(/deliberately wide/i);
  });

  it('claims no false precision: two cycles are wider than eight', () => {
    const two = analyzeLengths(
      generateCycleLengths({ count: 2, meanDays: 28, sdDays: 1, seed: 8 })
    );
    const eight = analyzeLengths(
      generateCycleLengths({ count: 8, meanDays: 28, sdDays: 1, seed: 8 })
    );
    expect(current(two.prediction).interval80.widthDays).toBeGreaterThan(
      current(eight.prediction).interval80.widthDays
    );
    expect(two.confidence).toBeLessThan(eight.confidence);
  });

  it('moves through the cold start tiers exactly as specified', () => {
    const tiers = [0, 1, 2, 3, 4, 5, 6, 9].map((count) => {
      const lengths = new Array(count).fill(28);
      return analyzeLengths(lengths).confidenceTier;
    });
    expect(tiers).toEqual([
      'none',
      'low',
      'low',
      'moderate',
      'moderate',
      'moderate',
      'high',
      'high',
    ]);
  });
});
