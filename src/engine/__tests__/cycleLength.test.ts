import { describe, expect, it } from 'vitest';
import {
  PRIOR_ALPHA0,
  PRIOR_BETA0,
  PRIOR_KAPPA0,
  PRIOR_MU0,
  RECENCY_HALF_LIFE_CYCLES,
} from '../constants';
import {
  fitCycleLength,
  posteriorMedian,
  predictiveInterval,
  predictiveQuantile,
  priorPosterior,
  recencyWeights,
} from '../cycleLength';

/** Effectively no decay, for comparing against an unweighted fit. */
const NO_DECAY_HALF_LIFE = 1e9;

describe('recencyWeights', () => {
  it('gives the most recent cycle full weight', () => {
    const weights = recencyWeights(5);
    expect(weights).toHaveLength(5);
    expect(weights[4]).toBeCloseTo(1, 12);
  });

  it('halves at exactly one half life back', () => {
    const weights = recencyWeights(RECENCY_HALF_LIFE_CYCLES + 1);
    expect(weights[0]).toBeCloseTo(0.5, 12);
  });

  it('is monotonically increasing from oldest to newest', () => {
    const weights = recencyWeights(12);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i] as number).toBeGreaterThan(weights[i - 1] as number);
    }
  });

  it('rejects a non-positive half life', () => {
    expect(() => recencyWeights(3, 0)).toThrow(RangeError);
  });
});

describe('the prior', () => {
  it('is the population baseline', () => {
    const prior = priorPosterior();
    expect(prior.observationCount).toBe(0);
    expect(prior.weightSum).toBe(0);
    expect(prior.mu).toBe(PRIOR_MU0);
    expect(prior.kappa).toBe(PRIOR_KAPPA0);
    expect(prior.alpha).toBe(PRIOR_ALPHA0);
    expect(prior.beta).toBe(PRIOR_BETA0);
  });

  it('has a prior mean variance of 25, so a standard deviation of 5 days', () => {
    expect(PRIOR_BETA0 / (PRIOR_ALPHA0 - 1)).toBeCloseTo(25, 12);
  });

  it('produces the Student-t predictive the formulas call for', () => {
    const { predictive } = priorPosterior();
    expect(predictive.degreesOfFreedom).toBe(2 * PRIOR_ALPHA0);
    expect(predictive.location).toBe(PRIOR_MU0);
    expect(predictive.scale).toBeCloseTo(
      Math.sqrt((PRIOR_BETA0 * (PRIOR_KAPPA0 + 1)) / (PRIOR_ALPHA0 * PRIOR_KAPPA0)),
      12
    );
  });

  it('is what an empty observation list returns', () => {
    expect(fitCycleLength([])).toEqual(priorPosterior());
  });
});

describe('the weighted conjugate update', () => {
  it('matches a hand computation for a single observation', () => {
    // W = 1, xbar = 30.
    // kappa = 1 + 1 = 2
    // mu    = (1 * 29 + 1 * 30) / 2 = 29.5
    // alpha = 3 + 0.5 = 3.5
    // beta  = 50 + 0 + (1 * 1 * 1^2) / (2 * 2) = 50.25
    const posterior = fitCycleLength([30]);
    expect(posterior.weightSum).toBeCloseTo(1, 12);
    expect(posterior.kappa).toBeCloseTo(2, 12);
    expect(posterior.mu).toBeCloseTo(29.5, 12);
    expect(posterior.alpha).toBeCloseTo(3.5, 12);
    expect(posterior.beta).toBeCloseTo(50.25, 12);
    expect(posterior.predictive.degreesOfFreedom).toBeCloseTo(7, 12);
    expect(posterior.predictive.scale).toBeCloseTo(Math.sqrt((50.25 * 3) / (3.5 * 2)), 12);
  });

  it('matches a hand computation for two recency-weighted observations', () => {
    // weights   = [0.5^(1/6), 1] = [0.8908987, 1]
    // W         = 1.8908987
    // xbar      = (28 * 0.8908987 + 30) / 1.8908987 = 29.0574...
    const posterior = fitCycleLength([28, 30]);
    const w0 = Math.pow(0.5, 1 / 6);
    const weightSum = w0 + 1;
    const xbar = (28 * w0 + 30) / weightSum;
    const kappa = PRIOR_KAPPA0 + weightSum;

    expect(posterior.weightSum).toBeCloseTo(weightSum, 12);
    expect(posterior.kappa).toBeCloseTo(kappa, 12);
    expect(posterior.alpha).toBeCloseTo(PRIOR_ALPHA0 + weightSum / 2, 12);
    expect(posterior.mu).toBeCloseTo((PRIOR_KAPPA0 * PRIOR_MU0 + weightSum * xbar) / kappa, 12);
    // Spelled out against the independently written expected numbers.
    expect(posterior.weightSum).toBeCloseTo(1.8908987, 6);
    expect(posterior.mu).toBeCloseTo(29.03774, 4);
    expect(posterior.beta).toBeCloseTo(50.94339, 4);
  });

  it('keeps kappa and alpha tied to the effective sample size', () => {
    const posterior = fitCycleLength([27, 28, 29, 30, 31, 32, 33]);
    expect(posterior.kappa).toBeCloseTo(PRIOR_KAPPA0 + posterior.weightSum, 12);
    expect(posterior.alpha).toBeCloseTo(PRIOR_ALPHA0 + posterior.weightSum / 2, 12);
  });

  it('pulls the estimate between the prior and the observed mean', () => {
    const posterior = fitCycleLength([35, 35, 35, 35, 35, 35]);
    expect(posterior.mu).toBeGreaterThan(PRIOR_MU0);
    expect(posterior.mu).toBeLessThan(35);
  });

  it('shrinks less as evidence accumulates', () => {
    const few = fitCycleLength([35, 35]);
    const many = fitCycleLength(new Array(20).fill(35));
    expect(Math.abs(35 - many.mu)).toBeLessThan(Math.abs(35 - few.mu));
  });
});

describe('the posterior predictive', () => {
  it('is wide with no data and tighter with plenty of consistent data', () => {
    const cold = priorPosterior().predictive.standardDeviation;
    const warm = fitCycleLength(new Array(12).fill(28)).predictive.standardDeviation;
    expect(cold).toBeGreaterThan(warm);
  });

  it('is wider for variable cycles than for consistent ones at the same count', () => {
    const steady = fitCycleLength([28, 28, 29, 28, 29, 28, 28, 29]);
    const erratic = fitCycleLength([22, 38, 26, 41, 24, 35, 27, 39]);
    expect(erratic.predictive.standardDeviation).toBeGreaterThan(
      steady.predictive.standardDeviation
    );
  });

  it('has its median at the location, because the t is symmetric', () => {
    const posterior = fitCycleLength([30, 31, 29]);
    expect(posteriorMedian(posterior)).toBe(posterior.predictive.location);
  });
});

describe('predictiveInterval', () => {
  const posterior = fitCycleLength([28, 29, 28, 30, 28, 29]);

  it('is centred on the location', () => {
    const { low, high } = predictiveInterval(posterior.predictive, 0.8);
    expect((low + high) / 2).toBeCloseTo(posterior.predictive.location, 10);
  });

  it('nests the 50% interval inside the 80% interval', () => {
    const narrow = predictiveInterval(posterior.predictive, 0.5);
    const wide = predictiveInterval(posterior.predictive, 0.8);
    expect(wide.low).toBeLessThan(narrow.low);
    expect(wide.high).toBeGreaterThan(narrow.high);
  });

  it('scales linearly with the widen factor', () => {
    const plain = predictiveInterval(posterior.predictive, 0.8, 1);
    const widened = predictiveInterval(posterior.predictive, 0.8, 1.5);
    const plainHalfWidth = (plain.high - plain.low) / 2;
    const widenedHalfWidth = (widened.high - widened.low) / 2;
    expect(widenedHalfWidth / plainHalfWidth).toBeCloseTo(1.5, 10);
  });

  it('rejects impossible arguments', () => {
    expect(() => predictiveInterval(posterior.predictive, 0)).toThrow(RangeError);
    expect(() => predictiveInterval(posterior.predictive, 1)).toThrow(RangeError);
    expect(() => predictiveInterval(posterior.predictive, 0.8, 0.5)).toThrow(RangeError);
  });
});

describe('predictiveQuantile', () => {
  const posterior = fitCycleLength([28, 29, 28, 30, 28, 29]);

  it('puts the median at the location and the tails either side of it', () => {
    expect(predictiveQuantile(posterior.predictive, 0.5)).toBeCloseTo(
      posterior.predictive.location,
      10
    );
    expect(predictiveQuantile(posterior.predictive, 0.99)).toBeGreaterThan(
      predictiveQuantile(posterior.predictive, 0.8)
    );
    expect(predictiveQuantile(posterior.predictive, 0.01)).toBeLessThan(
      posterior.predictive.location
    );
  });

  it('agrees with the two-sided interval it is built from', () => {
    const { low, high } = predictiveInterval(posterior.predictive, 0.8);
    expect(predictiveQuantile(posterior.predictive, 0.1)).toBeCloseTo(low, 10);
    expect(predictiveQuantile(posterior.predictive, 0.9)).toBeCloseTo(high, 10);
  });

  it('moves the tail out with the widen factor', () => {
    const plain = predictiveQuantile(posterior.predictive, 0.99, 1);
    const widened = predictiveQuantile(posterior.predictive, 0.99, 1.5);
    expect(widened - posterior.predictive.location).toBeCloseTo(
      1.5 * (plain - posterior.predictive.location),
      10
    );
  });

  it('rejects impossible arguments', () => {
    expect(() => predictiveQuantile(posterior.predictive, 0)).toThrow(RangeError);
    expect(() => predictiveQuantile(posterior.predictive, 1)).toThrow(RangeError);
    expect(() => predictiveQuantile(posterior.predictive, 0.99, 0.5)).toThrow(RangeError);
  });
});

describe('recency weighting versus an unweighted fit', () => {
  it('tracks an upward drift instead of averaging it away', () => {
    const drifting = [27, 27, 28, 28, 29, 30, 30, 31, 32, 32, 33, 33];
    const weighted = fitCycleLength(drifting);
    const unweighted = fitCycleLength(drifting, NO_DECAY_HALF_LIFE);
    expect(weighted.mu).toBeGreaterThan(unweighted.mu);
  });

  it('makes no difference when nothing is drifting', () => {
    const flat = new Array(12).fill(29);
    expect(fitCycleLength(flat).mu).toBeCloseTo(fitCycleLength(flat, NO_DECAY_HALF_LIFE).mu, 6);
  });
});
