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
