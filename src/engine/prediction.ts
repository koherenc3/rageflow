/**
 * Turning the layer 1 posterior into dates.
 *
 * The engine never hands back a bare date. Every prediction carries a 50% and
 * an 80% credible interval, because the honest answer to "when is my next
 * period" is a range and pretending otherwise is the single most common thing
 * cycle apps get wrong.
 */

import { addRoundedDays, compareDates, diffDays, type ISODate } from './date';
import { INTERVAL_50, INTERVAL_80 } from './constants';
import { predictiveInterval } from './cycleLength';
import { coldStartMessage, confidenceFor, confidenceTierFor, isPersonalized } from './confidence';
import type { CredibleInterval, CycleLengthPosterior, NextStartPrediction } from './types';

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

export interface PredictNextStartInput {
  /** Most recent logged period start. Absent when nothing has been logged. */
  lastStartDate?: ISODate;
  /** Used as the anchor when there is no logged start at all. */
  today: ISODate;
  posterior: CycleLengthPosterior;
  /** Complete, non-skipped cycles in the fit. */
  usedCycleCount: number;
  /** Period starts in the log, which can exceed `usedCycleCount` by one. */
  loggedStartCount: number;
  /** Interval multiplier from layer 3. */
  widenFactor?: number;
}

export function predictNextStart(input: PredictNextStartInput): NextStartPrediction {
  const {
    lastStartDate,
    today,
    posterior,
    usedCycleCount,
    loggedStartCount,
    widenFactor = 1,
  } = input;

  const anchor = lastStartDate ?? today;
  const expectedCycleLengthDays = posterior.predictive.location;
  const pointDate = addRoundedDays(anchor, expectedCycleLengthDays);
  const interval50 = intervalFrom(anchor, posterior, INTERVAL_50, widenFactor);
  const interval80 = intervalFrom(anchor, posterior, INTERVAL_80, widenFactor);

  const confidence = confidenceFor(
    posterior.weightSum,
    posterior.predictive.standardDeviation,
    posterior.halfLife
  );
  const confidenceTier = confidenceTierFor(usedCycleCount);
  const personalized = isPersonalized(usedCycleCount);

  // Once today is past the far end of the 80% range, this prediction has been
  // contradicted by the calendar: the period it describes did not arrive, or it
  // did and was not logged. Either way the dates below are in the past, and a
  // sentence beginning "next period most likely around" would be a plain false
  // statement. The threshold is the model's own interval rather than a day
  // count, so a regular history gives up on itself sooner than a variable one.
  const staleSince =
    lastStartDate !== undefined && compareDates(today, interval80.range.end) > 0
      ? lastStartDate
      : undefined;

  const basis =
    lastStartDate === undefined
      ? `Counting from today, ${today}, because no period has been logged yet.`
      : `Counting from your last logged start, ${lastStartDate}.`;

  const summary =
    staleSince !== undefined
      ? [
          `This prediction is out of date. Your last logged period start was ${staleSince}, ${diffDays(staleSince, today)} days ago, which is past the ${interval80.range.end} end of the 80% range it claimed.`,
          'Log a period start, either one you missed or your next one, to get a current estimate.',
          coldStartMessage(usedCycleCount, loggedStartCount),
        ].join(' ')
      : [
          `Next period most likely around ${pointDate}.`,
          `There is a 50% chance it falls between ${interval50.range.start} and ${interval50.range.end}, and an 80% chance between ${interval80.range.start} and ${interval80.range.end}.`,
          basis,
          coldStartMessage(usedCycleCount, loggedStartCount),
        ].join(' ');

  return {
    ...(lastStartDate === undefined ? {} : { lastStartDate }),
    pointDate,
    expectedCycleLengthDays,
    interval50,
    interval80,
    appliedWidenFactor: widenFactor,
    confidence,
    confidenceTier,
    personalized,
    isStale: staleSince !== undefined,
    summary,
  };
}
