/**
 * The confidence number is a claim about how sure the engine is, so the scale
 * it is reported on has to mean what it says. These tests pin both ends of it:
 * a history that has not earned confidence stays near the floor, and the top of
 * the scale is an asymptote rather than a plateau, so the number keeps answering
 * "how sure are you" no matter how much history she has.
 */

import { describe, expect, it } from 'vitest';
import { confidenceFor, confidenceTierFor } from '../confidence';
import { fitCycleLength, maxWeightSum, minPredictiveSd } from '../cycleLength';
import { analyze, logFromStartDates } from '../index';
import { CONFIDENCE_MAX, CONFIDENCE_SD_CEILING_DAYS } from '../constants';
import { generateCycleLengths, startDatesFromLengths } from '../testing/synthetic';
import type { CycleAnalysis } from '../types';

function analyzeLengths(lengths: readonly number[]): CycleAnalysis {
  const starts = startDatesFromLengths('2023-02-01', lengths);
  return analyze(logFromStartDates(starts), { today: starts[starts.length - 1] as string });
}

describe('the limits of the model', () => {
  it('caps the effective sample size at the geometric series limit', () => {
    // Documented in docs/RESEARCH.md as the price of tracking drift.
    expect(maxWeightSum()).toBeCloseTo(9.1658, 4);
    // Summed term by term the series lands on the limit to within rounding,
    // which is why the data factor is clamped rather than assumed to be a share.
    expect(fitCycleLength(new Array(500).fill(29)).weightSum).toBeCloseTo(maxWeightSum(), 9);
  });

  it('cannot claim a predictive spread tighter than the priors allow', () => {
    expect(minPredictiveSd()).toBeCloseTo(2.8884, 4);
    // Not even five hundred identical cycles beat it.
    expect(fitCycleLength(new Array(500).fill(29)).predictive.standardDeviation).toBeGreaterThan(
      minPredictiveSd() - 1e-6
    );
  });
});

describe('confidenceFor', () => {
  it('touches the ceiling only at the mathematical limits of the model', () => {
    // Both endpoints have to be attained exactly and simultaneously, which no
    // finite history does. This is the definition of the top of the scale, not
    // a value she can ever be shown.
    expect(confidenceFor(maxWeightSum(), minPredictiveSd())).toBe(CONFIDENCE_MAX);
  });

  it('never exceeds the ceiling', () => {
    expect(confidenceFor(1e6, 0)).toBe(CONFIDENCE_MAX);
    expect(confidenceFor(maxWeightSum(), minPredictiveSd())).toBeLessThanOrEqual(CONFIDENCE_MAX);
  });

  it('keeps climbing rather than plateauing, over any history she could log', () => {
    // The point of this test: the ceiling scales the result, it does not cap
    // it. If it is ever clamped again, the top of the range goes flat and the
    // number stops responding to the extra cycles that earned it.
    const confidenceAt = (count: number): number => {
      const posterior = fitCycleLength(new Array(count).fill(29));
      return confidenceFor(posterior.weightSum, posterior.predictive.standardDeviation);
    };

    // Perfectly identical cycles, so the only thing changing is how many.
    // Nine years of them, well past any history this app will ever see.
    const counts = [1, 2, 3, 6, 12, 24, 36, 48, 60, 90, 120];
    const values = counts.map(confidenceAt);

    for (let i = 1; i < values.length; i += 1) {
      expect(values[i] as number).toBeGreaterThan(values[i - 1] as number);
      expect(values[i] as number).toBeLessThan(CONFIDENCE_MAX);
    }
  });

  it('is zero without data and zero once the spread is useless', () => {
    expect(confidenceFor(0, 3)).toBe(0);
    expect(confidenceFor(-1, 3)).toBe(0);
    expect(confidenceFor(5, CONFIDENCE_SD_CEILING_DAYS)).toBe(0);
    expect(confidenceFor(5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('rises with data and falls with spread', () => {
    expect(confidenceFor(2, 4)).toBeGreaterThan(confidenceFor(1, 4));
    expect(confidenceFor(6, 4)).toBeGreaterThan(confidenceFor(2, 4));
    expect(confidenceFor(6, 5)).toBeLessThan(confidenceFor(6, 3));
  });
});

describe('confidence over a real history', () => {
  it('stays low for one or two cycles', () => {
    expect(analyzeLengths([28]).confidence).toBeLessThan(0.1);
    expect(analyzeLengths([28, 28]).confidence).toBeLessThan(0.2);
  });

  it('climbs towards the ceiling over years of very regular cycles, without landing on it', () => {
    const twoYears = analyzeLengths(
      generateCycleLengths({ count: 24, meanDays: 28, sdDays: 1, seed: 21 })
    );
    const fiveYears = analyzeLengths(
      generateCycleLengths({ count: 60, meanDays: 28, sdDays: 1, seed: 21 })
    );
    expect(twoYears.confidence).toBeGreaterThan(0.8);
    expect(fiveYears.confidence).toBeGreaterThan(twoYears.confidence);
    expect(fiveYears.confidence).toBeLessThan(CONFIDENCE_MAX);
  });

  it('does not reach the ceiling on a long but variable history', () => {
    const variable = analyzeLengths(
      generateCycleLengths({ count: 60, meanDays: 31, sdDays: 7, seed: 22 })
    );
    expect(variable.confidence).toBeLessThan(0.7);
  });

  it('leaves the cold start tiers alone', () => {
    expect([0, 1, 2, 3, 6].map(confidenceTierFor)).toEqual([
      'none',
      'low',
      'low',
      'moderate',
      'high',
    ]);
  });
});
