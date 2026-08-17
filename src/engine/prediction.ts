/**
 * Turning the layer 1 posterior into dates.
 *
 * The engine never hands back a bare date. Every prediction carries a 50% and
 * an 80% credible interval, because the honest answer to "when is my next
 * period" is a range and pretending otherwise is the single most common thing
 * cycle apps get wrong.
 *
 * Two shapes come out of here. {@link nextStartEstimate} is the arithmetic, with
 * every date populated, and it is what calibration grades and what the phase
 * model is anchored to. {@link describePrediction} is what a consumer may show,
 * and it withholds dates as the calendar overtakes them: the intervals once
 * today is past the far end of the 80% range, and everything once the log has
 * gone stale.
 */

import { addRoundedDays, compareDates, diffDays, type ISODate } from './date';
import {
  INTERVAL_50,
  INTERVAL_80,
  STALE_MIN_ELAPSED_CYCLES,
  STALE_PREDICTIVE_QUANTILE,
} from './constants';
import { predictiveInterval, predictiveQuantile } from './cycleLength';
import { coldStartMessage, confidenceFor, confidenceTierFor, isPersonalized } from './confidence';
import type {
  CredibleInterval,
  CycleLengthPosterior,
  NextStartEstimate,
  NextStartPrediction,
} from './types';

function intervalFrom(
  anchor: ISODate,
  posterior: CycleLengthPosterior,
  level: number,
  widenFactor: number
): CredibleInterval {
  const { low, high } = predictiveInterval(posterior.predictive, level, widenFactor);
  const start = addRoundedDays(anchor, low);
  const end = addRoundedDays(anchor, high);
  return { level, range: { start, end }, widthDays: diffDays(start, end) + 1 };
}

/**
 * The last day this prediction still describes a cycle that is under way.
 *
 * Two gates, and the later of the two wins because both have to be crossed. The
 * quantile is the model's own far tail, so it scales with how sure the fit is.
 * The floor is a flat two expected cycles, because the thing being detected is a
 * log that stopped rather than a period that is running late, and an interval
 * bound alone fires on ordinary late cycles roughly one time in ten.
 */
function validThroughFor(
  anchor: ISODate,
  posterior: CycleLengthPosterior,
  widenFactor: number
): ISODate {
  const tail = predictiveQuantile(posterior.predictive, STALE_PREDICTIVE_QUANTILE, widenFactor);
  const floor = STALE_MIN_ELAPSED_CYCLES * posterior.predictive.location;
  return addRoundedDays(anchor, Math.max(tail, floor));
}

/** Everything the arithmetic needs, and nothing else. */
export interface PredictNextStartInput {
  /** Most recent logged period start. Absent when nothing has been logged. */
  lastStartDate?: ISODate;
  /** Used as the anchor when there is no logged start at all. */
  today: ISODate;
  posterior: CycleLengthPosterior;
  /** Complete, non-skipped cycles in the fit. */
  usedCycleCount: number;
  /** Interval multiplier from layer 3. */
  widenFactor?: number;
}

/**
 * The extra field only the wording needs.
 *
 * It is split out rather than sitting on {@link PredictNextStartInput} because
 * nothing in {@link nextStartEstimate} reads it, and a required field that the
 * arithmetic ignores makes every caller that wants only the numbers invent a
 * value to satisfy the type.
 */
export interface DescribeNextStartInput extends PredictNextStartInput {
  /** Period starts in the log, which can exceed `usedCycleCount` by one. */
  loggedStartCount: number;
}

/** The dates the model computes, with nothing withheld. */
export function nextStartEstimate(input: PredictNextStartInput): NextStartEstimate {
  const { lastStartDate, today, posterior, usedCycleCount, widenFactor = 1 } = input;

  const anchor = lastStartDate ?? today;
  const expectedCycleLengthDays = posterior.predictive.location;

  return {
    ...(lastStartDate === undefined ? {} : { lastStartDate }),
    pointDate: addRoundedDays(anchor, expectedCycleLengthDays),
    expectedCycleLengthDays,
    interval50: intervalFrom(anchor, posterior, INTERVAL_50, widenFactor),
    interval80: intervalFrom(anchor, posterior, INTERVAL_80, widenFactor),
    validThrough: validThroughFor(anchor, posterior, widenFactor),
    appliedWidenFactor: widenFactor,
    confidence: confidenceFor(
      posterior.weightSum,
      posterior.predictive.standardDeviation,
      posterior.halfLife
    ),
    confidenceTier: confidenceTierFor(usedCycleCount),
    personalized: isPersonalized(usedCycleCount),
  };
}

function dayNoun(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * What a consumer is allowed to see, in three tiers cut at boundaries the model
 * already computes.
 *
 * While today is inside the 80% interval the prediction is presented in full.
 * That bound is deliberately not the point date: a period arriving a day or two
 * after the most likely date is the ordinary case the interval exists to cover,
 * and dropping the range there would throw away the honest part of the answer.
 *
 * Past the interval the prediction has been outlived by the calendar. Its point
 * date is reported in the past tense as the date the period was expected, and
 * both intervals are dropped, because every day in them has already been and
 * gone and a range offered as when the period is due would be false.
 *
 * Past `validThrough` the silence has run longer than the model can account for
 * and every date goes, including the one that was expected. A sentence beginning
 * "next period most likely around" is a plain false statement in either of the
 * last two tiers, and a boolean beside a still-present `pointDate` only helps
 * the consumer who remembers to read it, which is why the union is discriminated
 * rather than optional.
 */
export function describePrediction(
  estimate: NextStartEstimate,
  input: DescribeNextStartInput
): NextStartPrediction {
  const { today, usedCycleCount, loggedStartCount } = input;
  const { lastStartDate } = estimate;
  const history = coldStartMessage(
    usedCycleCount,
    loggedStartCount,
    input.posterior.predictive.standardDeviation
  );

  const common = {
    ...(lastStartDate === undefined ? {} : { lastStartDate }),
    expectedCycleLengthDays: estimate.expectedCycleLengthDays,
    appliedWidenFactor: estimate.appliedWidenFactor,
    confidence: estimate.confidence,
    confidenceTier: estimate.confidenceTier,
    personalized: estimate.personalized,
    coldStartMessage: history,
  };

  if (lastStartDate !== undefined && compareDates(today, estimate.validThrough) > 0) {
    return {
      ...common,
      lastStartDate,
      isLate: false,
      isStale: true,
      summary: [
        `This prediction is out of date. Your last logged period start was ${lastStartDate}, ${diffDays(lastStartDate, today)} days ago, and nothing has been logged since.`,
        'Log a period start, either one you missed or your next one, to get a current estimate.',
        history,
      ].join(' '),
    };
  }

  if (lastStartDate !== undefined && compareDates(today, estimate.interval80.range.end) > 0) {
    const daysLate = diffDays(estimate.pointDate, today);
    return {
      ...common,
      lastStartDate,
      isLate: true,
      isStale: false,
      expectedDate: estimate.pointDate,
      daysLate,
      summary: [
        `Your period was expected around ${estimate.pointDate}, ${dayNoun(daysLate)} ago, and the range around that date has passed with nothing logged since ${lastStartDate}.`,
        'Log a period start when it arrives and the estimate will pick up from there.',
        history,
      ].join(' '),
    };
  }

  const basis =
    lastStartDate === undefined
      ? `Counting from today, ${today}, because no period has been logged yet.`
      : `Counting from your last logged start, ${lastStartDate}.`;

  return {
    ...common,
    isLate: false,
    isStale: false,
    pointDate: estimate.pointDate,
    interval50: estimate.interval50,
    interval80: estimate.interval80,
    summary: [
      `Next period most likely around ${estimate.pointDate}.`,
      `There is a 50% chance it falls between ${estimate.interval50.range.start} and ${estimate.interval50.range.end}, and an 80% chance between ${estimate.interval80.range.start} and ${estimate.interval80.range.end}.`,
      basis,
      history,
    ].join(' '),
  };
}

export function predictNextStart(input: DescribeNextStartInput): NextStartPrediction {
  return describePrediction(nextStartEstimate(input), input);
}
