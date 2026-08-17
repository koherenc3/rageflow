/**
 * The two headline properties. These are the product claim, stated as
 * assertions.
 *
 *   1. The thing learns. Mean absolute error falls as cycles accumulate.
 *   2. The thing is honest about what it does not know. An interval labelled
 *      80% contains the truth about 80% of the time.
 *
 * Both are measured across a population of simulated users rather than one
 * history, because a single 16 cycle run is far too small a sample to say
 * anything about coverage. Every draw is seeded, so these numbers are fixed.
 */

import { describe, expect, it } from 'vitest';
import { analyze, logFromStartDates } from '../index';
import { generateCycleLengths, startDatesFromLengths } from '../testing/synthetic';
import type { CalibrationRecord } from '../types';

const CYCLES_PER_PERSON = 16;
const FIRST_START = '2022-01-03';

interface Person {
  meanDays: number;
  sdDays: number;
  seed: number;
}

function recordsFor(person: Person): readonly CalibrationRecord[] {
  const lengths = generateCycleLengths({
    count: CYCLES_PER_PERSON,
    meanDays: person.meanDays,
    sdDays: person.sdDays,
    seed: person.seed,
  });
  const starts = startDatesFromLengths(FIRST_START, lengths);
  return analyze(logFromStartDates(starts), { today: starts[starts.length - 1] as string })
    .calibration.records;
}

function meanOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe('property 1: mean absolute error falls as cycle count rises', () => {
  /**
   * A population whose typical cycle lengths are spread either side of the
   * population prior. Someone whose cycles happen to be exactly 29 days long
   * has nothing to teach the model, so a population centred on the prior would
   * make this property untestable rather than true.
   */
  const population: Person[] = Array.from({ length: 40 }, (_, index) => ({
    meanDays: 24 + (index % 12),
    sdDays: 2,
    seed: 500 + index,
  }));

  const all = population.flatMap((person) => recordsFor(person));

  function maeOver(predicate: (record: CalibrationRecord) => boolean): number {
    const selected = all.filter(predicate).map((record) => Math.abs(record.errorDays));
    expect(selected.length).toBeGreaterThan(50);
    return meanOf(selected);
  }

  it('is worse over the first three cycles than over the tenth onward', () => {
    const early = maeOver((record) => record.cycleIndex < 3);
    const late = maeOver((record) => record.cycleIndex >= 9);
    expect(late).toBeLessThan(early);
    // Not a marginal improvement: the late error should be well under the early.
    expect(late).toBeLessThan(0.75 * early);
  });

  it('falls monotonically across four consecutive blocks of history', () => {
    const blocks = [
      maeOver((record) => record.cycleIndex < 2),
      maeOver((record) => record.cycleIndex >= 2 && record.cycleIndex < 5),
      maeOver((record) => record.cycleIndex >= 5 && record.cycleIndex < 9),
      maeOver((record) => record.cycleIndex >= 9),
    ];
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i] as number).toBeLessThan(blocks[i - 1] as number);
    }
  });

  it('holds for a tightly regular population too', () => {
    const regular: Person[] = Array.from({ length: 30 }, (_, index) => ({
      meanDays: 25 + (index % 9),
      sdDays: 1,
      seed: 4000 + index,
    }));
    const records = regular.flatMap((person) => recordsFor(person));
    const early = meanOf(records.filter((r) => r.cycleIndex < 3).map((r) => Math.abs(r.errorDays)));
    const late = meanOf(records.filter((r) => r.cycleIndex >= 9).map((r) => Math.abs(r.errorDays)));
    expect(late).toBeLessThan(early);
  });

  it('narrows the intervals as it learns, not just the point estimate', () => {
    const early = meanOf(all.filter((r) => r.cycleIndex < 2).map((r) => r.interval80WidthDays));
    const late = meanOf(all.filter((r) => r.cycleIndex >= 9).map((r) => r.interval80WidthDays));
    expect(late).toBeLessThan(early);
  });
});

describe('property 2: an 80% interval contains the truth about 80% of the time', () => {
  /**
   * A mixed population spanning the range of cycle regularity the prior is
   * meant to describe. Individual variability from 3 to 7 days brackets the
   * prior's own 5 day standard deviation.
   */
  const population: Person[] = Array.from({ length: 80 }, (_, index) => ({
    meanDays: 25 + (index % 9),
    sdDays: 3 + (index % 5),
    seed: 2000 + index,
  }));

  const all = population.flatMap((person) => recordsFor(person));

  it('has a large enough sample to say anything', () => {
    expect(all.length).toBeGreaterThan(1000);
  });

  it('covers close to 80% of outcomes', () => {
    const coverage = meanOf(all.map((record) => (record.within80 ? 1 : 0)));
    expect(coverage).toBeGreaterThan(0.75);
    expect(coverage).toBeLessThan(0.9);
  });

  it('covers close to 50% of outcomes with the narrower interval', () => {
    const coverage = meanOf(all.map((record) => (record.within50 ? 1 : 0)));
    expect(coverage).toBeGreaterThan(0.45);
    expect(coverage).toBeLessThan(0.65);
  });

  it('errs towards over-covering rather than under-covering', () => {
    // Being wider than claimed is a much smaller sin than being narrower.
    // Checked separately for each level of individual variability.
    for (const sdDays of [3, 4, 5, 6, 7]) {
      const cohort = Array.from({ length: 30 }, (_, index) => ({
        meanDays: 26 + (index % 8),
        sdDays,
        seed: 6000 + sdDays * 100 + index,
      })).flatMap((person) => recordsFor(person));
      const coverage = meanOf(cohort.map((record) => (record.within80 ? 1 : 0)));
      expect(coverage).toBeGreaterThan(0.72);
    }
  });

  it('does not achieve coverage by making the intervals useless', () => {
    const width = meanOf(all.map((record) => record.interval80WidthDays));
    expect(width).toBeLessThan(20);
  });

  it('stays covered even when the true cycle length is far from the prior', () => {
    const cohort = Array.from({ length: 30 }, (_, index) => ({
      meanDays: 38 + (index % 4),
      sdDays: 4,
      seed: 8000 + index,
    })).flatMap((person) => recordsFor(person));
    // Early predictions are anchored on a prior centred at 29 days, so they
    // will miss. What matters is that the model recovers rather than staying
    // confidently wrong.
    const late = cohort.filter((record) => record.cycleIndex >= 6);
    const coverage = meanOf(late.map((record) => (record.within80 ? 1 : 0)));
    expect(coverage).toBeGreaterThan(0.7);
  });
});
