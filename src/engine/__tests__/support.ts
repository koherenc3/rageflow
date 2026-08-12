/**
 * Test-only helpers. Not part of the engine and not scanned by the purity test,
 * which skips this directory.
 */

import type { CurrentNextStartPrediction, NextStartPrediction } from '../types';

/**
 * Narrow a prediction to the current one, failing loudly if it has gone stale.
 *
 * A stale prediction has no `pointDate` and no intervals, which is the whole
 * point of the union, so a test that wants those dates has to say it expects
 * them to be there.
 */
export function current(prediction: NextStartPrediction): CurrentNextStartPrediction {
  if (prediction.isStale) {
    throw new Error(`Expected a current prediction, got a stale one: ${prediction.summary}`);
  }
  return prediction;
}
