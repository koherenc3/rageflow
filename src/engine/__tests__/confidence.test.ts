/**
 * The confidence number is a claim about how sure the engine is, so the scale
 * it is reported on has to mean what it says. These tests pin both ends of it:
 * a history that has not earned confidence stays near the floor, and the top of
 * the scale is an asymptote rather than a plateau, so the number keeps answering
 * "how sure are you" no matter how much history she has.
 */

import { describe, expect, it } from 'vitest';
import { coldStartMessage, confidenceFor, confidenceTierFor } from '../confidence';
import { fitCycleLength, maxWeightSum, minPredictiveSd, priorPosterior } from '../cycleLength';
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

  it('is zero without data, and only without data', () => {
    // Zero is reserved for having nothing to fit. A history of genuinely erratic
    // cycles has earned a very low number rather than the number an empty log
    // gets, and a UI reading them off the same scale has to be able to tell the
    // two apart.
    expect(confidenceFor(0, 3)).toBe(0);
    expect(confidenceFor(-1, 3)).toBe(0);
    for (const spread of [CONFIDENCE_SD_CEILING_DAYS, 20, 100, Number.POSITIVE_INFINITY]) {
      expect(confidenceFor(5, spread)).toBeGreaterThan(0);
      expect(confidenceFor(5, spread)).toBeLessThan(0.05);
    }
  });

  it('keeps falling past the point where the spread is useless', () => {
    // The floor is an asymptote and not a plateau, the same way the ceiling is.
    const spreads = [CONFIDENCE_SD_CEILING_DAYS, 12, 16, 24, 40];
    const values = spreads.map((spread) => confidenceFor(5, spread));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i] as number).toBeLessThan(values[i - 1] as number);
      expect(values[i] as number).toBeGreaterThan(0);
    }
  });

  it('leaves the useful part of the scale to the ramp', () => {
    // The tail only takes over where the ramp has all but run out, so every fit
    // worth reporting on reads exactly as it did before there was a floor.
    const ramp = (spread: number): number =>
      (CONFIDENCE_MAX * (CONFIDENCE_SD_CEILING_DAYS - spread)) /
      (CONFIDENCE_SD_CEILING_DAYS - minPredictiveSd());
    for (const spread of [3, 4, 5, 6, 7, 8, 9]) {
      expect(confidenceFor(maxWeightSum(), spread)).toBeCloseTo(ramp(spread), 10);
    }
  });

  it('rises with data and falls with spread', () => {
    expect(confidenceFor(2, 4)).toBeGreaterThan(confidenceFor(1, 4));
    expect(confidenceFor(6, 4)).toBeGreaterThan(confidenceFor(2, 4));
    expect(confidenceFor(6, 5)).toBeLessThan(confidenceFor(6, 3));
  });

  it('scales against the half life the fit actually used', () => {
    // Both endpoints of the scale are functions of the recency half life, and
    // `fitCycleLength` takes one. Measuring a short-half-life fit against the
    // default's limits would report roughly half the confidence the data earned,
    // with nothing in the number to show it.
    for (const halfLife of [3, 6, 12]) {
      const saturated = fitCycleLength(new Array(500).fill(29), halfLife);
      expect(saturated.halfLife).toBe(halfLife);
      expect(
        confidenceFor(
          saturated.weightSum,
          saturated.predictive.standardDeviation,
          saturated.halfLife
        )
      ).toBeGreaterThan(0.9);
    }

    // The bug this replaced: a half life of 3 saturates at a weight sum of about
    // 4.85, so scoring it against the default's 9.17 halves the answer.
    const short = fitCycleLength(new Array(500).fill(29), 3);
    expect(confidenceFor(short.weightSum, short.predictive.standardDeviation)).toBeLessThan(
      0.6 * confidenceFor(short.weightSum, short.predictive.standardDeviation, short.halfLife)
    );
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

  it('reads as low rather than as empty for years of erratic cycles', () => {
    // The pairing this exists to prevent: a `high` tier and a message about
    // having enough history, next to a confidence that says the engine knows
    // nothing. Two of those three are correct. The number is genuinely low
    // because the range genuinely is wide, so the wording is what has to give.
    const erratic = analyzeLengths(
      generateCycleLengths({ count: 60, meanDays: 31, sdDays: 15, seed: 21 })
    );
    expect(erratic.confidenceTier).toBe('high');
    expect(erratic.confidence).toBeLessThan(0.1);
    expect(erratic.confidence).toBeGreaterThan(0);
    expect(erratic.coldStartMessage).toMatch(/plenty of history/i);
    expect(erratic.coldStartMessage).toMatch(/range stays wide/i);
    expect(erratic.coldStartMessage).not.toMatch(/confidence properly/i);
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

describe('coldStartMessage', () => {
  it('does not call a wide range trustworthy just because there is a lot of it', () => {
    // Same volume, same tier, different spread. The tier stays volume-driven,
    // which is deliberate, so the sentence is where the spread has to show up.
    const tight = coldStartMessage(24, 25, 3);
    const wide = coldStartMessage(24, 25, 12);
    expect(tight).toMatch(/confidence properly/i);
    expect(wide).toMatch(/plenty of history/i);
    expect(wide).toMatch(/range stays wide/i);
    expect(wide).not.toMatch(/confidence properly/i);
    expect(wide).toMatch(/24 cycles/);
  });

  it('measures wide against the population baseline rather than a tuned number', () => {
    // A fit no tighter than the untouched prior has bought no precision at all,
    // however many cycles are behind it.
    const baseline = priorPosterior().predictive.standardDeviation;
    expect(coldStartMessage(24, 25, baseline)).toMatch(/range stays wide/i);
    expect(coldStartMessage(24, 25, baseline - 0.01)).toMatch(/confidence properly/i);
    expect(coldStartMessage(24, 25, Number.POSITIVE_INFINITY)).toMatch(/range stays wide/i);
  });

  it('leaves the thinner tiers to volume alone', () => {
    expect(coldStartMessage(0, 0, 12)).toMatch(/no periods logged yet/i);
    expect(coldStartMessage(0, 1, 12)).toMatch(/only one period logged/i);
    expect(coldStartMessage(2, 3, 12)).toMatch(/deliberately wide/i);
    expect(coldStartMessage(4, 5, 12)).toMatch(/still tightening/i);
  });

  it('keeps its volume-only wording when no spread is supplied', () => {
    expect(coldStartMessage(24, 25)).toMatch(/confidence properly/i);
  });
});
