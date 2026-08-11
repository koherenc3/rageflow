/**
 * Layer 1: the model of how long her cycle is.
 *
 * A Normal-Inverse-Gamma conjugate prior over cycle length, updated with
 * recency-weighted observations, giving a Student-t posterior predictive.
 *
 * The choice is deliberate. The predictive is naturally wide when the data is
 * thin and tightens as cycles accumulate, so the honesty of the interval is a
 * property of the arithmetic rather than a heuristic somebody tuned. A plain
 * mean and sample standard deviation would claim a two-day interval off two
 * cycles, which would be a lie.
 */

import {
  PRIOR_ALPHA0,
  PRIOR_BETA0,
  PRIOR_KAPPA0,
  PRIOR_MU0,
  RECENCY_HALF_LIFE_CYCLES,
} from './constants';
import { studentTQuantile, studentTStandardDeviation } from './stats';
import type { CycleLengthPosterior, StudentTPredictive } from './types';

/**
 * Recency weights for `n` observations, oldest first.
 *
 * Observation `i` (1-based, so `i = n` is the most recent) gets
 * `0.5 ^ ((n - i) / halfLife)`. The newest cycle always weighs 1.
 */
export function recencyWeights(
  count: number,
  halfLife: number = RECENCY_HALF_LIFE_CYCLES
): number[] {
  if (halfLife <= 0) throw new RangeError(`Half life must be positive: ${halfLife}`);
  const weights: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    weights.push(Math.pow(0.5, (count - i) / halfLife));
  }
  return weights;
}

function predictiveFrom(
  mu: number,
  kappa: number,
  alpha: number,
  beta: number
): StudentTPredictive {
  const degreesOfFreedom = 2 * alpha;
  const scale = Math.sqrt((beta * (kappa + 1)) / (alpha * kappa));
  return {
    degreesOfFreedom,
    location: mu,
    scale,
    standardDeviation: scale * studentTStandardDeviation(degreesOfFreedom),
  };
}

/** The untouched population prior, used when nothing has been logged. */
export function priorPosterior(): CycleLengthPosterior {
  return {
    observationCount: 0,
    weightSum: 0,
    mu: PRIOR_MU0,
    kappa: PRIOR_KAPPA0,
    alpha: PRIOR_ALPHA0,
    beta: PRIOR_BETA0,
    predictive: predictiveFrom(PRIOR_MU0, PRIOR_KAPPA0, PRIOR_ALPHA0, PRIOR_BETA0),
  };
}

/**
 * Weighted Normal-Inverse-Gamma update over observed cycle lengths, oldest
 * first. Suspected missed logs must already be filtered out by the caller.
 */
export function fitCycleLength(
  lengths: readonly number[],
  halfLife: number = RECENCY_HALF_LIFE_CYCLES
): CycleLengthPosterior {
  if (lengths.length === 0) return priorPosterior();

  const weights = recencyWeights(lengths.length, halfLife);

  let weightSum = 0;
  let weightedTotal = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const w = weights[i] as number;
    weightSum += w;
    weightedTotal += w * (lengths[i] as number);
  }
  const xbar = weightedTotal / weightSum;

  let weightedSquares = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const deviation = (lengths[i] as number) - xbar;
    weightedSquares += (weights[i] as number) * deviation * deviation;
  }

  const kappa = PRIOR_KAPPA0 + weightSum;
  const mu = (PRIOR_KAPPA0 * PRIOR_MU0 + weightSum * xbar) / kappa;
  const alpha = PRIOR_ALPHA0 + weightSum / 2;
  const beta =
    PRIOR_BETA0 +
    0.5 * weightedSquares +
    (PRIOR_KAPPA0 * weightSum * (xbar - PRIOR_MU0) * (xbar - PRIOR_MU0)) / (2 * kappa);

  return {
    observationCount: lengths.length,
    weightSum,
    mu,
    kappa,
    alpha,
    beta,
    predictive: predictiveFrom(mu, kappa, alpha, beta),
  };
}

/**
 * Central credible interval of the posterior predictive, in days.
 *
 * `widenFactor` comes from layer 3: when measured coverage has been running
 * below nominal, the interval is stretched about its centre.
 */
export function predictiveInterval(
  predictive: StudentTPredictive,
  level: number,
  widenFactor = 1
): { low: number; high: number } {
  if (!(level > 0 && level < 1)) {
    throw new RangeError(`Credible level must be in (0, 1): ${level}`);
  }
  if (!(widenFactor >= 1)) {
    throw new RangeError(`Widen factor must be at least 1: ${widenFactor}`);
  }
  const tail = (1 - level) / 2;
  const halfWidth =
    Math.abs(studentTQuantile(1 - tail, predictive.degreesOfFreedom)) *
    predictive.scale *
    widenFactor;
  return { low: predictive.location - halfWidth, high: predictive.location + halfWidth };
}

/** Posterior median of cycle length. The Student-t is symmetric, so this is the location. */
export function posteriorMedian(posterior: CycleLengthPosterior): number {
  return posterior.predictive.location;
}
