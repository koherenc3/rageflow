/**
 * Test-only helpers. Not part of the engine and not scanned by the purity test,
 * which skips this directory.
 */

import type {
  CurrentNextStartPrediction,
  LateNextStartPrediction,
  NextStartPrediction,
} from '../types';

/**
 * The day the fixtures in these tests are derived on.
 *
 * Derivation reads today for one purpose: deciding which starts have happened.
 * Every hand-written fixture that uses this constant is in the past by here, so
 * the derivation takes all of its starts whatever `today` the case under test
 * goes on to set. Cases about a start dated after today set their own.
 */
export const AFTER_EVERY_START = '2024-12-31';

/**
 * Narrow a prediction to the current one, failing loudly if the calendar has
 * overtaken it.
 *
 * A late prediction has no intervals and a stale one has no dates at all, which
 * is the whole point of the union, so a test that wants those dates has to say
 * it expects them to be there.
 */
export function current(prediction: NextStartPrediction): CurrentNextStartPrediction {
  if (prediction.isStale) {
    throw new Error(`Expected a current prediction, got a stale one: ${prediction.summary}`);
  }
  if (prediction.isLate) {
    throw new Error(`Expected a current prediction, got a late one: ${prediction.summary}`);
  }
  return prediction;
}

/** Narrow a prediction to the late one, failing loudly if it is not. */
export function late(prediction: NextStartPrediction): LateNextStartPrediction {
  if (!prediction.isLate) {
    throw new Error(`Expected a late prediction, got: ${prediction.summary}`);
  }
  return prediction;
}
