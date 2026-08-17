import {
  COLD_START_LOW_MAX_CYCLES,
  COLD_START_MODERATE_MAX_CYCLES,
  CONFIDENCE_MAX,
  CONFIDENCE_PRECISION_TAIL,
  CONFIDENCE_SD_CEILING_DAYS,
  RECENCY_HALF_LIFE_CYCLES,
} from './constants';
import { maxWeightSum, minPredictiveSd, priorPosterior } from './cycleLength';
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
 *
 * Each factor is a share of what the model can attain, so 1 means "as much data
 * as the recency weighting can ever hold" and "as tight as these priors can ever
 * be" rather than an unreachable ideal. Only a long and very regular history
 * gets near the top; a cycle or two still lands well down the scale.
 *
 * Both of those endpoints depend on the recency half life, so it is a parameter
 * here and the caller passes the one the fit actually used (`posterior.halfLife`).
 * Measuring a weight sum from a short half life against the default's ceiling
 * would silently report about half the confidence the data has earned, and
 * nothing in the returned number would show it.
 *
 * The ceiling scales the result rather than truncating it. Clamping would put a
 * plateau at the top: past some point every history reports 0.95 and the number
 * stops answering the one question it exists to answer. Scaling keeps it moving
 * with every extra cycle and every tighter interval, at the price of 0.95 being
 * an asymptote that a real history approaches and never quite reaches. Both of
 * the factors are already bounded to [0, 1], so the result cannot exceed it.
 *
 * The bottom of the precision factor is an asymptote too, and for the same
 * reason in reverse. The linear ramp reaches zero at the spread ceiling, and a
 * factor of zero makes the whole number zero, so years of genuinely erratic
 * cycles reported exactly what a log with nothing in it reports. Those are
 * different states. Under the ramp sits a geometric tail that is worth
 * `CONFIDENCE_PRECISION_TAIL` at the ceiling and keeps decaying past it without
 * ever arriving at zero, so a very low number stays a number rather than
 * collapsing into the no-data case. The tail only bites where the ramp has
 * nearly run out, so every history tight enough to be worth reporting on is
 * unaffected. Zero is left to mean one thing: no data.
 */
export function confidenceFor(
  weightSum: number,
  predictiveSd: number,
  halfLife: number = RECENCY_HALF_LIFE_CYCLES
): number {
  if (weightSum <= 0) return 0;
  const dataFactor = clamp(weightSum / maxWeightSum(halfLife), 0, 1);
  const spread = Number.isFinite(predictiveSd) ? predictiveSd : CONFIDENCE_SD_CEILING_DAYS;
  const tightest = minPredictiveSd(halfLife);
  // 0 at the tightest spread the priors allow, 1 at the ceiling, unbounded past it.
  const excess = Math.max(0, spread - tightest) / (CONFIDENCE_SD_CEILING_DAYS - tightest);
  const precisionFactor = Math.max(
    clamp(1 - excess, 0, 1),
    Math.pow(CONFIDENCE_PRECISION_TAIL, excess)
  );
  return CONFIDENCE_MAX * dataFactor * precisionFactor;
}

function cycleNoun(count: number): string {
  return count === 1 ? '1 cycle' : `${count} cycles`;
}

/**
 * A fit no tighter than knowing nothing about her at all.
 *
 * The comparison is against the untouched population prior's own predictive
 * spread rather than a tuned threshold, so it says exactly what it means: her
 * cycles vary enough that all that history has bought no more precision than the
 * baseline everyone starts from.
 */
function isWideSpread(predictiveSdDays: number | undefined): boolean {
  if (predictiveSdDays === undefined) return false;
  return !(predictiveSdDays < priorPosterior().predictive.standardDeviation);
}

/**
 * The sentence the UI shows about how much history the prediction rests on.
 *
 * `loggedStartCount` only changes the wording of the no-data case: one logged
 * period gives us somewhere to count from but no observed cycle length, so the
 * length estimate is still entirely the population prior and has to say so.
 *
 * `predictiveSdDays` splits the top tier in two. Volume alone drives the tier,
 * which is deliberate, but volume alone does not make a prediction worth
 * trusting: a long history of genuinely erratic cycles has plenty of data and a
 * range that stays wide anyway. Saying there is enough history to report
 * confidence properly next to a confidence near zero reads as a contradiction,
 * so the wide case names the spread instead. Omit it and the wording stays
 * volume-only.
 */
export function coldStartMessage(
  usedCycleCount: number,
  loggedStartCount = usedCycleCount,
  predictiveSdDays?: number
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
      return isWideSpread(predictiveSdDays)
        ? `Based on ${cycleNoun(usedCycleCount)}. That is plenty of history, but your cycles vary enough that the range stays wide.`
        : `Based on ${cycleNoun(usedCycleCount)}. There is enough history to report confidence properly.`;
  }
}

/** True once at least one of her own cycles is in the fit. */
export function isPersonalized(usedCycleCount: number): boolean {
  return usedCycleCount > 0;
}
