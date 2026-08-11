/**
 * rageflow prediction engine.
 *
 * Pure TypeScript. No React, no Next, no browser APIs, no network, no storage.
 * Everything here is a function of the log you pass in, which keeps it testable
 * in a plain node process and portable to another runtime later. The lint
 * config enforces the boundary; see eslint.config.mjs.
 *
 * The layers:
 *   1. cycleLength.ts  how long her cycle is, as a distribution
 *   2. phases.ts       where in the cycle a given day sits
 *   3. calibration.ts  how well the engine has actually been doing, fed back in
 */

import { todayLocal, type ISODate } from './date';
import {
  clinicalNotes as deriveClinicalNotes,
  deriveCycles,
  fittableLengths,
  lastStartDate,
  observedPeriodLengths,
} from './cycles';
import { fitCycleLength } from './cycleLength';
import { buildCalibration } from './calibration';
import { predictNextStart } from './prediction';
import { buildPhaseModel, learnLutealLength, learnPeriodLength, phaseForDate } from './phases';
import { coldStartMessage, confidenceFor, confidenceTierFor, isPersonalized } from './confidence';
import type { CycleAnalysis, CycleLog, DayEntry } from './types';
import type { PhaseInputs } from './phases';

export interface AnalyzeOptions {
  /** The day to report on. Defaults to the host's local calendar date. */
  today?: ISODate;
  /**
   * Observed luteal lengths, for a future LH or temperature input. Nothing in
   * v1 supplies these; the parameter exists so adding them later is not an
   * engine rewrite.
   */
  lutealObservations?: readonly number[];
}

/** Everything the engine knows, given a log. */
export function analyze(log: CycleLog, options: AnalyzeOptions = {}): CycleAnalysis {
  const today = options.today ?? todayLocal();

  const { cycles, missedLogSuspicions } = deriveCycles(log);
  const lengths = fittableLengths(cycles);
  const posterior = fitCycleLength(lengths);
  const calibration = buildCalibration(cycles);

  const prediction = predictNextStart({
    ...(lastStartDate(cycles) === undefined ? {} : { lastStartDate: lastStartDate(cycles) }),
    today,
    posterior,
    usedCycleCount: lengths.length,
    loggedStartCount: cycles.length,
    widenFactor: calibration.widenFactor,
  });

  const confidence = confidenceFor(posterior.weightSum, posterior.predictive.standardDeviation);
  const confidenceTier = confidenceTierFor(lengths.length);

  const phaseInputs: PhaseInputs = {
    cycles,
    predictedNextStart: prediction.pointDate,
    lutealLength: learnLutealLength(options.lutealObservations ?? []),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles)),
    confidence,
    confidenceTier,
  };

  const currentPhase = phaseForDate(phaseInputs, today);

  return {
    today,
    cycles,
    usedCycleCount: lengths.length,
    posterior,
    prediction,
    phases: buildPhaseModel(phaseInputs),
    ...(currentPhase === undefined ? {} : { currentPhase }),
    calibration,
    clinicalNotes: deriveClinicalNotes(cycles),
    missedLogSuspicions,
    confidence,
    confidenceTier,
    personalized: isPersonalized(lengths.length),
    coldStartMessage: coldStartMessage(lengths.length, cycles.length),
  };
}

/**
 * Build a log from period start dates. The whole input surface of v1, in one
 * function.
 */
export function logFromStartDates(startDates: readonly ISODate[]): CycleLog {
  const entries: DayEntry[] = startDates.map((date) => ({ date, kind: 'period-start' }));
  return { version: 1, entries };
}

export * from './types';
export {
  addDays,
  addRoundedDays,
  compareDates,
  diffDays,
  formatDate,
  fromDayNumber,
  isAfter,
  isBefore,
  isValidISODate,
  isWithin,
  maxDate,
  minDate,
  parseDate,
  roundDays,
  sortDates,
  toDayNumber,
  todayLocal,
} from './date';
export type { ISODate, CalendarParts } from './date';
export { deriveCycles, fittableLengths, observedPeriodLengths } from './cycles';
export { fitCycleLength, predictiveInterval, priorPosterior, recencyWeights } from './cycleLength';
export { predictNextStart } from './prediction';
export {
  buildPhaseModel,
  learnLength,
  learnLutealLength,
  learnPeriodLength,
  phaseForDate,
} from './phases';
export type { PhaseInputs } from './phases';
export { buildCalibration, gradePrediction, summarizeCalibration } from './calibration';
export { coldStartMessage, confidenceFor, confidenceTierFor } from './confidence';
export { studentTCdf, studentTQuantile } from './stats';
