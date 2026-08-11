/**
 * Layer 3: the engine grading its own work.
 *
 * Every time a real period start arrives we can look back at what was predicted
 * before it, how wide the claimed interval was, and whether the truth landed
 * inside. That gives a measured error and a measured coverage, and if coverage
 * is running below nominal the intervals widen until it is not.
 *
 * This is what makes the thing adaptive rather than merely Bayesian: the model
 * can be wrong about its own uncertainty, and this layer notices.
 *
 * Calibration is recomputed from the log rather than stored, so it can never
 * disagree with the entries it is derived from.
 */

import {
  CALIBRATION_MAX_WIDEN_FACTOR,
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_WIDEN_GAIN,
  CALIBRATION_WIDEN_SHRINKAGE,
  INTERVAL_80,
} from './constants';
import { diffDays, isWithin, type ISODate } from './date';
import { fitCycleLength } from './cycleLength';
import { predictNextStart } from './prediction';
import { clamp } from './stats';
import type {
  CalibrationRecord,
  CalibrationSummary,
  DerivedCycle,
  NextStartPrediction,
} from './types';

/** Grade one prediction against the start that actually happened. */
export function gradePrediction(
  cycleIndex: number,
  prediction: NextStartPrediction,
  actualDate: ISODate
): CalibrationRecord {
  const interval50 = prediction.interval50.range;
  const interval80 = prediction.interval80.range;
  return {
    cycleIndex,
    predictedDate: prediction.pointDate,
    actualDate,
    errorDays: diffDays(prediction.pointDate, actualDate),
    interval50,
    interval80,
    within50: isWithin(actualDate, interval50.start, interval50.end),
    within80: isWithin(actualDate, interval80.start, interval80.end),
    interval80WidthDays: prediction.interval80.widthDays,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function averageOf(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function widenFactorFor(sampleCount: number, coverage80: number): number {
  if (sampleCount < CALIBRATION_MIN_SAMPLES || !Number.isFinite(coverage80)) return 1;
  const shortfall = Math.max(0, INTERVAL_80 - coverage80);
  if (shortfall === 0) return 1;
  const trust = sampleCount / (sampleCount + CALIBRATION_WIDEN_SHRINKAGE);
  return clamp(1 + CALIBRATION_WIDEN_GAIN * shortfall * trust, 1, CALIBRATION_MAX_WIDEN_FACTOR);
}

function summaryText(
  sampleCount: number,
  meanAbsoluteErrorDays: number,
  coverage80: number,
  widenFactor: number
): string {
  if (sampleCount === 0) {
    return 'Not enough history yet to measure how accurate these predictions have been.';
  }
  const attempts = sampleCount === 1 ? '1 prediction' : `${sampleCount} predictions`;
  const parts = [
    `Across ${attempts} the average miss was ${meanAbsoluteErrorDays.toFixed(1)} days.`,
    `Your period landed inside the 80% range ${Math.round(coverage80 * 100)}% of the time.`,
  ];
  if (widenFactor > 1) {
    parts.push('That is below the 80% it should be, so the ranges have been widened to match.');
  }
  return parts.join(' ');
}

export function summarizeCalibration(records: readonly CalibrationRecord[]): CalibrationSummary {
  const absoluteErrors = records.map((record) => Math.abs(record.errorDays));
  const meanAbsoluteErrorDays = averageOf(absoluteErrors);
  const medianAbsoluteErrorDays = median(absoluteErrors);
  const coverage50 = averageOf(records.map((record) => (record.within50 ? 1 : 0)));
  const coverage80 = averageOf(records.map((record) => (record.within80 ? 1 : 0)));
  const meanInterval80WidthDays = averageOf(records.map((record) => record.interval80WidthDays));
  const widenFactor = widenFactorFor(records.length, coverage80);

  return {
    records,
    sampleCount: records.length,
    meanAbsoluteErrorDays,
    medianAbsoluteErrorDays,
    coverage50,
    coverage80,
    meanInterval80WidthDays,
    widenFactor,
    summary: summaryText(records.length, meanAbsoluteErrorDays, coverage80, widenFactor),
  };
}

/** An empty calibration, for a log with nothing to grade yet. */
export function emptyCalibration(): CalibrationSummary {
  return summarizeCalibration([]);
}

/**
 * Replay the log and grade every prediction the engine would have made.
 *
 * Each step fits only on the cycles before it and widens using only the records
 * before it, so nothing leaks backwards from the future. That makes the reported
 * mean absolute error and coverage the real out-of-sample numbers, not a
 * flattering in-sample fit.
 *
 * Suspected missed logs are skipped rather than graded: the prediction missed
 * because an entry is absent, and charging that to the model would make it
 * widen its intervals to cover a data-entry problem.
 */
export function buildCalibration(cycles: readonly DerivedCycle[]): CalibrationSummary {
  const records: CalibrationRecord[] = [];
  const acceptedLengths: number[] = [];
  let loggedStartCount = 0;

  for (const cycle of cycles) {
    loggedStartCount += 1;
    if (cycle.lengthDays === undefined || cycle.nextStartDate === undefined) continue;
    if (cycle.suspectedMissedLog) continue;

    const posterior = fitCycleLength(acceptedLengths);
    const prediction = predictNextStart({
      lastStartDate: cycle.startDate,
      today: cycle.startDate,
      posterior,
      usedCycleCount: acceptedLengths.length,
      loggedStartCount,
      widenFactor: summarizeCalibration(records).widenFactor,
    });

    records.push(gradePrediction(cycle.index, prediction, cycle.nextStartDate));
    acceptedLengths.push(cycle.lengthDays);
  }

  return summarizeCalibration(records);
}
