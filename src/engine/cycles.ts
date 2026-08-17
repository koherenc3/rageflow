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
  MAX_FITTABLE_PERIOD_LENGTH_DAYS,
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
  FutureDatedStart,
  InvalidLogEntry,
  MissedLogSuspicion,
} from './types';

/**
 * The report for an entry whose date is not a calendar date.
 *
 * One corrupt row in a persisted log used to take the whole analysis down with
 * it, which is the least useful thing it could do: she would see nothing at all
 * rather than the rest of a history that is perfectly readable. It is the same
 * treatment a future-dated start gets, for the same reason. The entry is left in
 * the log untouched, never deleted and never silently rewritten, and the report
 * is what lets a UI say why a row she can see is not counted.
 */
function invalidEntry(kind: DayEntry['kind'], date: unknown): InvalidLogEntry {
  return {
    date,
    kind,
    message: `A ${kind === 'period-start' ? 'period start' : 'period end'} is logged as ${JSON.stringify(date)}, which is not a calendar date in YYYY-MM-DD form. It is left out of the analysis and stays in your log.`,
  };
}

/** The logged period starts, sorted and de-duplicated, unreadable ones reported. */
function collectStarts(entries: readonly DayEntry[], invalid: InvalidLogEntry[]): ISODate[] {
  const seen = new Set<ISODate>();
  const seenInvalid = new Set<unknown>();
  for (const entry of entries) {
    if (entry.kind !== 'period-start') continue;
    if (!isValidISODate(entry.date)) {
      if (seenInvalid.has(entry.date)) continue;
      seenInvalid.add(entry.date);
      invalid.push(invalidEntry('period-start', entry.date));
      continue;
    }
    seen.add(entry.date);
  }
  return [...seen].sort(compareDates);
}

/** The logged end dates, sorted and de-duplicated, unreadable ones reported. */
function collectEnds(entries: readonly DayEntry[], invalid: InvalidLogEntry[]): ISODate[] {
  const seen = new Set<ISODate>();
  const seenInvalid = new Set<unknown>();
  for (const entry of entries) {
    if (entry.kind !== 'period-end') continue;
    if (!isValidISODate(entry.date)) {
      if (seenInvalid.has(entry.date)) continue;
      seenInvalid.add(entry.date);
      invalid.push(invalidEntry('period-end', entry.date));
      continue;
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
  futureDatedStarts: FutureDatedStart[];
  invalidEntries: InvalidLogEntry[];
}

/**
 * Derive cycles from a log, flagging suspected missed logs as we go.
 *
 * The judgement for each gap uses only the cycles before it, which is what she
 * would have seen at the time and keeps the pass free of hindsight.
 *
 * `today` decides one thing: which starts have happened. A start dated after it
 * is not a cycle yet, so it is left out of the derivation and reported in
 * `futureDatedStarts` instead of anchoring the model to a day nobody has lived
 * through. Everything downstream is indexed off the last logged start, so one
 * mistyped year would move the whole model there and take the prediction, the
 * phases and the calibration replay with it.
 *
 * The entry itself is untouched: it stays in the log, it is reported rather than
 * dropped in silence, and it starts counting on the day it arrives. That is the
 * same treatment an implausible bleed length gets in `observedPeriodLengths`,
 * and for the same reason. This is health data she typed in and the app does not
 * get to overwrite it.
 *
 * An end date is matched to a cycle by date alone, and the position of an entry
 * in `log.entries` means nothing. `CycleLog.entries` is documented as a flat
 * list of dated entries with no ordering invariant, and the analysis is asserted
 * to give the same answer whatever order they arrive in, so a storage layer that
 * sorts on load, an import that merges two files, or a UI that rewrites an entry
 * in place cannot change what a log means. The three rules are:
 *
 *  - an end belongs to the latest start at or before it,
 *  - it must fall strictly before the next start, and
 *  - for the last cycle it must additionally not be dated after today, and must
 *    fall within {@link MAX_FITTABLE_PERIOD_LENGTH_DAYS} of the start, to be
 *    attributed at all.
 *
 * The third rule is what bounds the only cycle that has no next start to stop
 * the search. Without it an end dated past every start could land only there,
 * so a mistyped year moved onto each new last cycle as she logged starts: the
 * cycle carrying it has no readable bleed end and so gets no fertility estimate,
 * and the migration spread that from the one cycle she wrote it on to every
 * cycle after it. Bounding the last cycle keeps an unreadable entry where it was
 * written, and the next start she logs opens a cycle the engine can read again.
 *
 * Excluding a start excludes what belongs to it. An end sits between the start
 * it belongs to and the next one, so leaving a start out without keeping the
 * boundary it provided hands its end to the last cycle that was kept, which is
 * how a mistyped year once produced a 397 day period. `firstFutureStart` keeps
 * that boundary after the start itself is dropped. A start left out for not
 * being a calendar date leaves the same hole with no date to fill it, and the
 * bound on the last cycle is what covers it: an end far enough past the last
 * accepted start to have belonged to the unreadable one is outside the plausible
 * bleed length and is not attributed.
 *
 * A cycle that ends up with no end date is not a cycle with a short bleed. It is
 * one the engine cannot read, and the phase layer has to treat it that way; see
 * the deferred note in the pull request for the case that is still open. The
 * entry itself is untouched in every case, on the same terms as every other
 * entry the derivation cannot place: still in the log, never rewritten.
 */
export function deriveCycles(log: CycleLog, today: ISODate): DerivationResult {
  const invalidEntries: InvalidLogEntry[] = [];
  const loggedStarts = collectStarts(log.entries, invalidEntries);

  const starts: ISODate[] = [];
  const futureDatedStarts: FutureDatedStart[] = [];
  for (const date of loggedStarts) {
    if (compareDates(date, today) > 0) {
      futureDatedStarts.push({
        date,
        message: `A period start is logged for ${date}, which is after today, ${today}. It is not counted as a cycle until that day arrives.`,
      });
      continue;
    }
    starts.push(date);
  }
  // Sorted, so the first excluded start is the earliest of them and the last
  // accepted cycle stops there rather than running to the end of the log.
  const firstFutureStart = futureDatedStarts[0]?.date;
  // The same boundary from a start that has no readable date to provide one.
  const hasUnplaceableStart = invalidEntries.some((entry) => entry.kind === 'period-start');
  const ends = collectEnds(log.entries, invalidEntries);

  const cycles: DerivedCycle[] = [];
  const missedLogSuspicions: MissedLogSuspicion[] = [];
  const acceptedLengths: number[] = [];

  for (let index = 0; index < starts.length; index += 1) {
    const startDate = starts[index] as ISODate;
    const nextStartDate = starts[index + 1];

    // The logged end that belongs to this cycle: the earliest one falling on or
    // after this start and strictly before the next start she logged, whether or
    // not that next start was counted as a cycle. Anything else is a stray entry
    // or belongs to a start this derivation left out. `ends` is sorted, so the
    // search takes the earliest match.
    //
    // The last cycle has no next start to stop the search, so it takes an end
    // only if that end names a day she could already have observed. Without that
    // bound an end dated past every start could land only here, and would land
    // here again on each new last cycle as she logged starts, so one mistyped
    // year withheld the fertility estimate from every cycle after it rather than
    // from the one she wrote it on.
    //
    // An unreadable start leaves the same hole with no date to fill it, and
    // nothing says whether it sat before or after the ends that follow the last
    // accepted start. There the plausible bleed length is the only thing left to
    // tell the two apart: an end a few days after this start is the bleed of
    // this cycle, and one a month after it is far more likely to belong to the
    // start that could not be read, so it is left off rather than invented onto
    // this one. That bound applies only to that ambiguity. Everywhere else an
    // implausibly long end is hers, shown at the length she typed, because
    // discarding it lays the cycle out around a shorter bleed than she recorded
    // and publishes the fertility estimate across the difference.
    const endBoundary = nextStartDate ?? firstFutureStart;
    const isOpenCycle = nextStartDate === undefined;
    const boundaryIsUnknown = isOpenCycle && hasUnplaceableStart;
    const endDate = ends.find(
      (end) =>
        compareDates(end, startDate) >= 0 &&
        (endBoundary === undefined || compareDates(end, endBoundary) < 0) &&
        (!isOpenCycle || compareDates(end, today) <= 0) &&
        (!boundaryIsUnknown || diffDays(startDate, end) + 1 <= MAX_FITTABLE_PERIOD_LENGTH_DAYS)
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
        // No ratio and no tuning constant in the wording: the gate can fire
        // anywhere from a little over the threshold upwards, so the only claim
        // the sentence can always make is that the gap is longer than usual.
        question: `There are ${lengthDays} days between ${startDate} and ${nextStartDate}, longer than your usual ${Math.round(judgement.runningMedianDays)} days. Did a period start in between and not get logged?`,
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

  return { cycles, missedLogSuspicions, futureDatedStarts, invalidEntries };
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

/**
 * Observed bleed lengths that should go into the period-length fit.
 *
 * An end date logged weeks after the start is a typo, not a three week period,
 * and the fit is credulous enough that one of them would redefine what the app
 * calls menstruation. Implausible ones are left out of the fit here, exactly as
 * a suspected missed log is left out of the cycle-length fit. The entry stays on
 * the derived cycle, so her own history still shows what she actually recorded.
 *
 * An end dated after `today` is left out on the same terms, because it is not an
 * observation yet. A start on the 5th with the end mistyped as the 15th, read on
 * the 7th, is three days of bleeding counted as eleven, and the length it puts
 * into the fit biases every cycle after it upward. Nothing else about the entry
 * changes: it stays on the cycle, the phase layer still lays the cycle's windows
 * out around it, and the day it names starts counting when it arrives.
 */
export function observedPeriodLengths(cycles: readonly DerivedCycle[], today: ISODate): number[] {
  const lengths: number[] = [];
  for (const cycle of cycles) {
    const length = cycle.periodLengthDays;
    if (length === undefined) continue;
    if (length > MAX_FITTABLE_PERIOD_LENGTH_DAYS) continue;
    if (cycle.endDate !== undefined && compareDates(cycle.endDate, today) > 0) continue;
    lengths.push(length);
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
