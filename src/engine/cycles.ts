/**
 * Turning the raw log into cycles.
 *
 * A cycle is the interval between one period start and the next. That is the
 * only derivation, and it is done on every read rather than stored, so
 * correcting a mistyped start date automatically corrects everything built on
 * top of it.
 *
 * Skip detection lives here rather than in the UI because a gap that is really
 * two cycles poisons the variance estimate, and the variance estimate is what
 * every interval in the app is made of. Self-tracked data reliably contains
 * these; see docs/RESEARCH.md.
 */

import {
  CLINICAL_LONG_CYCLE_DAYS,
  CLINICAL_SHORT_CYCLE_DAYS,
  SKIP_MEDIAN_MULTIPLE,
  SKIP_MIN_ACCEPTED_CYCLES,
  SKIP_PREDICTIVE_SD_THRESHOLD,
} from './constants';
import { compareDates, diffDays, isValidISODate, type ISODate } from './date';
import { fitCycleLength, posteriorMedian } from './cycleLength';
import type {
  ClinicalFlag,
  ClinicalNote,
  CycleLog,
  DayEntry,
  DerivedCycle,
  MissedLogSuspicion,
} from './types';

function collectDates(entries: readonly DayEntry[], kind: DayEntry['kind']): ISODate[] {
  const seen = new Set<ISODate>();
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    if (!isValidISODate(entry.date)) {
      throw new RangeError(`Log entry has an invalid date: ${JSON.stringify(entry.date)}`);
    }
    seen.add(entry.date);
  }
  return [...seen].sort(compareDates);
}

function clinicalFlagsFor(lengthDays: number): ClinicalFlag[] {
  const flags: ClinicalFlag[] = [];
  if (lengthDays < CLINICAL_SHORT_CYCLE_DAYS) flags.push('unusually-short');
  if (lengthDays > CLINICAL_LONG_CYCLE_DAYS) flags.push('unusually-long');
  return flags;
}

/** Where a suspected skip was judged from, so the reasoning can be shown. */
interface SkipJudgement {
  suspected: boolean;
  runningMedianDays: number;
}

/**
 * Decide whether `gapDays` looks like two cycles recorded as one.
 *
 * Two independent gates, both of which must fire:
 *
 *  - the gap is more than {@link SKIP_MEDIAN_MULTIPLE} times her running
 *    typical cycle, which rules out a merely long cycle, and
 *  - it sits more than {@link SKIP_PREDICTIVE_SD_THRESHOLD} predictive standard
 *    deviations above the mean, which stops us flagging real cycles for someone
 *    whose cycles are genuinely all over the place.
 */
function judgeSkip(gapDays: number, acceptedLengths: readonly number[]): SkipJudgement {
  const posterior = fitCycleLength(acceptedLengths);
  const median = posteriorMedian(posterior);
  if (acceptedLengths.length < SKIP_MIN_ACCEPTED_CYCLES) {
    return { suspected: false, runningMedianDays: median };
  }
  const sd = posterior.predictive.standardDeviation;
  const exceedsMultiple = gapDays > SKIP_MEDIAN_MULTIPLE * median;
  const exceedsTail =
    Number.isFinite(sd) &&
    gapDays > posterior.predictive.location + SKIP_PREDICTIVE_SD_THRESHOLD * sd;
  return { suspected: exceedsMultiple && exceedsTail, runningMedianDays: median };
}

export interface DerivationResult {
  cycles: DerivedCycle[];
  missedLogSuspicions: MissedLogSuspicion[];
}

/**
 * Derive cycles from a log, flagging suspected missed logs as we go.
 *
 * The judgement for each gap uses only the cycles before it, which is what she
 * would have seen at the time and keeps the pass free of hindsight.
 */
export function deriveCycles(log: CycleLog): DerivationResult {
  const starts = collectDates(log.entries, 'period-start');
  const ends = collectDates(log.entries, 'period-end');

  const cycles: DerivedCycle[] = [];
  const missedLogSuspicions: MissedLogSuspicion[] = [];
  const acceptedLengths: number[] = [];

  for (let index = 0; index < starts.length; index += 1) {
    const startDate = starts[index] as ISODate;
    const nextStartDate = starts[index + 1];

    // The logged end that belongs to this cycle: on or after the start, and
    // strictly before the next one. Anything else is a stray entry.
    const endDate = ends.find(
      (candidate) =>
        compareDates(candidate, startDate) >= 0 &&
        (nextStartDate === undefined || compareDates(candidate, nextStartDate) < 0)
    );
    const periodLengthDays = endDate === undefined ? undefined : diffDays(startDate, endDate) + 1;

    if (nextStartDate === undefined) {
      cycles.push({
        index,
        startDate,
        ...(endDate === undefined ? {} : { endDate, periodLengthDays }),
        suspectedMissedLog: false,
        clinicalFlags: [],
      });
      continue;
    }

    const lengthDays = diffDays(startDate, nextStartDate);
    if (lengthDays <= 0) {
      throw new RangeError(
        `Period starts must be strictly increasing, got ${startDate} then ${nextStartDate}`
      );
    }

    const judgement = judgeSkip(lengthDays, acceptedLengths);
    if (judgement.suspected) {
      missedLogSuspicions.push({
        cycleIndex: index,
        startDate,
        nextStartDate,
        gapDays: lengthDays,
        runningMedianDays: judgement.runningMedianDays,
        question: `There are ${lengthDays} days between ${startDate} and ${nextStartDate}, about twice your usual ${Math.round(judgement.runningMedianDays)}. Did a period start in between and not get logged?`,
      });
    } else {
      acceptedLengths.push(lengthDays);
    }

    cycles.push({
      index,
      startDate,
      nextStartDate,
      lengthDays,
      ...(endDate === undefined ? {} : { endDate, periodLengthDays }),
      suspectedMissedLog: judgement.suspected,
      // A gap we do not believe is one cycle should not raise a clinical flag
      // about cycle length. Ask her about the gap first.
      clinicalFlags: judgement.suspected ? [] : clinicalFlagsFor(lengthDays),
    });
  }

  return { cycles, missedLogSuspicions };
}

/** Lengths that should go into the fit: complete cycles that are not suspected skips. */
export function fittableLengths(cycles: readonly DerivedCycle[]): number[] {
  const lengths: number[] = [];
  for (const cycle of cycles) {
    if (cycle.suspectedMissedLog) continue;
    if (cycle.lengthDays === undefined) continue;
    lengths.push(cycle.lengthDays);
  }
  return lengths;
}

/** Observed bleed lengths, for the period-length parameter. */
export function observedPeriodLengths(cycles: readonly DerivedCycle[]): number[] {
  const lengths: number[] = [];
  for (const cycle of cycles) {
    if (cycle.periodLengthDays !== undefined) lengths.push(cycle.periodLengthDays);
  }
  return lengths;
}

/**
 * Cycles worth mentioning to a doctor.
 *
 * The wording names the observation and suggests raising it. It must not
 * suggest a cause, because the engine has no way to know one.
 */
export function clinicalNotes(cycles: readonly DerivedCycle[]): ClinicalNote[] {
  const notes: ClinicalNote[] = [];
  for (const cycle of cycles) {
    if (cycle.lengthDays === undefined) continue;
    for (const flag of cycle.clinicalFlags) {
      const message =
        flag === 'unusually-short'
          ? `The cycle starting ${cycle.startDate} was ${cycle.lengthDays} days, shorter than the usual ${CLINICAL_SHORT_CYCLE_DAYS} to ${CLINICAL_LONG_CYCLE_DAYS} day range. It is worth mentioning to a doctor. This is not a diagnosis.`
          : `The cycle starting ${cycle.startDate} was ${cycle.lengthDays} days, longer than the usual ${CLINICAL_SHORT_CYCLE_DAYS} to ${CLINICAL_LONG_CYCLE_DAYS} day range. It is worth mentioning to a doctor. This is not a diagnosis.`;
      notes.push({
        cycleIndex: cycle.index,
        startDate: cycle.startDate,
        lengthDays: cycle.lengthDays,
        flag,
        message,
      });
    }
  }
  return notes;
}

/** Most recent logged period start, or undefined for an empty log. */
export function lastStartDate(cycles: readonly DerivedCycle[]): ISODate | undefined {
  const last = cycles[cycles.length - 1];
  return last?.startDate;
}
