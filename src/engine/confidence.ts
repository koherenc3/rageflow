import {
  COLD_START_LOW_MAX_CYCLES,
  COLD_START_MODERATE_MAX_CYCLES,
  CONFIDENCE_MAX,
  CONFIDENCE_SD_CEILING_DAYS,
  CONFIDENCE_SD_FLOOR_DAYS,
  CONFIDENCE_WEIGHT_SATURATION,
} from './constants';
import { clamp } from './stats';
import type { ConfidenceTier } from './types';

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
 */
export function confidenceFor(weightSum: number, predictiveSd: number): number {
  if (weightSum <= 0) return 0;
  const dataFactor = weightSum / (weightSum + CONFIDENCE_WEIGHT_SATURATION);
  const spread = Number.isFinite(predictiveSd) ? predictiveSd : CONFIDENCE_SD_CEILING_DAYS;
  const precisionFactor = clamp(
    (CONFIDENCE_SD_CEILING_DAYS - spread) / (CONFIDENCE_SD_CEILING_DAYS - CONFIDENCE_SD_FLOOR_DAYS),
    0,
    1
  );
  return clamp(dataFactor * precisionFactor, 0, CONFIDENCE_MAX);
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
