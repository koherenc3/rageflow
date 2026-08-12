import {
  COLD_START_LOW_MAX_CYCLES,
  COLD_START_MODERATE_MAX_CYCLES,
  CONFIDENCE_MAX,
  CONFIDENCE_SD_CEILING_DAYS,
} from './constants';
import { maxWeightSum, minPredictiveSd } from './cycleLength';
import { clamp } from './stats';
import type { ConfidenceTier } from './types';

/**
 * The two endpoints the scale is measured against, both of them properties of
 * the model rather than knobs. Scaling against an unreachable ideal instead
 * would leave the top of the range permanently empty and make the number mean
 * something different from what it says.
 */
const MAX_WEIGHT_SUM = maxWeightSum();
const MIN_PREDICTIVE_SD = minPredictiveSd();

/**
 * Cold start behaviour lives here, in the engine, so the UI cannot accidentally
 * present a population baseline as a personal prediction. The tiers are the
 * table in docs/PLAN.md.
 */
export function confidenceTierFor(usedCycleCount: number): ConfidenceTier {
  if (usedCycleCount <= 0) return 'none';
  if (usedCycleCount <= COLD_START_LOW_MAX_CYCLES) return 'low';
  if (usedCycleCount <= COLD_START_MODERATE_MAX_CYCLES) return 'moderate';
  return 'high';
}

/**
 * A single number in [0, 1] combining how much data we have with how tight the
 * predictive distribution came out.
 *
 * Both matter and neither substitutes for the other: six cycles of wildly
 * variable length should not read as confident, and one cycle should not read
 * as confident just because the interval happens to be narrow.
 *
 * Each factor is a share of what the model can attain, so 1 means "as much data
 * as the recency weighting can ever hold" and "as tight as these priors can ever
 * be" rather than an unreachable ideal. Only a long and very regular history
 * gets near the top; a cycle or two still lands well down the scale.
 *
 * The ceiling scales the result rather than truncating it. Clamping would put a
 * plateau at the top: past some point every history reports 0.95 and the number
 * stops answering the one question it exists to answer. Scaling keeps it moving
 * with every extra cycle and every tighter interval, at the price of 0.95 being
 * an asymptote that a real history approaches and never quite reaches. Both of
 * the factors are already bounded to [0, 1], so the result cannot exceed it.
 */
export function confidenceFor(weightSum: number, predictiveSd: number): number {
  if (weightSum <= 0) return 0;
  const dataFactor = clamp(weightSum / MAX_WEIGHT_SUM, 0, 1);
  const spread = Number.isFinite(predictiveSd) ? predictiveSd : CONFIDENCE_SD_CEILING_DAYS;
  const precisionFactor = clamp(
    (CONFIDENCE_SD_CEILING_DAYS - spread) / (CONFIDENCE_SD_CEILING_DAYS - MIN_PREDICTIVE_SD),
    0,
    1
  );
  return CONFIDENCE_MAX * dataFactor * precisionFactor;
}

function cycleNoun(count: number): string {
  return count === 1 ? '1 cycle' : `${count} cycles`;
}

/**
 * The sentence the UI shows about how much history the prediction rests on.
 *
 * `loggedStartCount` only changes the wording of the no-data case: one logged
 * period gives us somewhere to count from but no observed cycle length, so the
 * length estimate is still entirely the population prior and has to say so.
 */
export function coldStartMessage(
  usedCycleCount: number,
  loggedStartCount = usedCycleCount
): string {
  switch (confidenceTierFor(usedCycleCount)) {
    case 'none':
      return loggedStartCount > 0
        ? 'Only one period logged so far, so the length estimate is a population baseline and is not personalized to you.'
        : 'No periods logged yet. This is a population baseline and is not personalized to you.';
    case 'low':
      return `Based on ${cycleNoun(usedCycleCount)}. The range is deliberately wide and will tighten as you log more.`;
    case 'moderate':
      return `Based on ${cycleNoun(usedCycleCount)}. This is personalized to you and the range is still tightening.`;
    case 'high':
      return `Based on ${cycleNoun(usedCycleCount)}. There is enough history to report confidence properly.`;
  }
}

/** True once at least one of her own cycles is in the fit. */
export function isPersonalized(usedCycleCount: number): boolean {
  return usedCycleCount > 0;
}
