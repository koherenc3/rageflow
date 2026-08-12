/**
 * Layer 2: where in the cycle a given day sits.
 *
 * Two learned lengths drive this, both of them parameters with priors rather
 * than constants.
 *
 * Luteal length is famously quoted as a fixed 14 days. It is not fixed. It
 * varies between women and from cycle to cycle within one woman (see
 * docs/RESEARCH.md), so it is modelled as a learned parameter whose prior is 13
 * days with a 2 day standard deviation. With start-date-only logging there is
 * no observation that can move it, so it correctly sits at the prior and says
 * so. The update hook exists now so LH strips or temperature could sharpen it
 * later without reworking the engine.
 *
 * Most cycle-to-cycle variation is follicular, not luteal, which is why
 * everything here is indexed backward from the predicted next start rather than
 * forward from the last one.
 */

import {
  FERTILE_DAYS_AFTER_OVULATION,
  FERTILE_DAYS_BEFORE_OVULATION,
  LUTEAL_OBSERVATION_SD_DAYS,
  LUTEAL_PRIOR_MEAN_DAYS,
  LUTEAL_PRIOR_SD_DAYS,
  PERIOD_OBSERVATION_SD_DAYS,
  PERIOD_PRIOR_MEAN_DAYS,
  PERIOD_PRIOR_SD_DAYS,
  PREMENSTRUAL_WINDOW_DAYS,
} from './constants';
import { addDays, compareDates, diffDays, isWithin, roundDays, type ISODate } from './date';
import type {
  ConfidenceTier,
  CyclePhase,
  DateRange,
  DerivedCycle,
  LearnedLength,
  PhaseEstimate,
  PhaseModel,
} from './types';

/**
 * Normal-normal conjugate update with a known observation standard deviation.
 *
 * Deliberately simple: these parameters have at most a handful of observations
 * behind them and a full hierarchical treatment would be precision the data
 * cannot support.
 */
export function learnLength(
  priorMeanDays: number,
  priorSdDays: number,
  observations: readonly number[],
  observationSdDays: number
): LearnedLength {
  if (observations.length === 0) {
    return {
      meanDays: priorMeanDays,
      sdDays: priorSdDays,
      observationCount: 0,
      isPrior: true,
    };
  }
  const priorPrecision = 1 / (priorSdDays * priorSdDays);
  const observationPrecision = 1 / (observationSdDays * observationSdDays);
  const total = observations.reduce((sum, value) => sum + value, 0);
  const posteriorPrecision = priorPrecision + observations.length * observationPrecision;
  const posteriorMean =
    (priorMeanDays * priorPrecision + total * observationPrecision) / posteriorPrecision;
  return {
    meanDays: posteriorMean,
    sdDays: Math.sqrt(1 / posteriorPrecision),
    observationCount: observations.length,
    isPrior: false,
  };
}

/**
 * The luteal length parameter.
 *
 * `observations` is the hook for a future LH or basal body temperature input.
 * Nothing in v1 supplies it, so this returns the prior, which is the honest
 * answer rather than a hardcoded 14.
 */
export function learnLutealLength(observations: readonly number[] = []): LearnedLength {
  return learnLength(
    LUTEAL_PRIOR_MEAN_DAYS,
    LUTEAL_PRIOR_SD_DAYS,
    observations,
    LUTEAL_OBSERVATION_SD_DAYS
  );
}

/** The bleed length parameter, learned from logged end dates when she records them. */
export function learnPeriodLength(observations: readonly number[] = []): LearnedLength {
  return learnLength(
    PERIOD_PRIOR_MEAN_DAYS,
    PERIOD_PRIOR_SD_DAYS,
    observations,
    PERIOD_OBSERVATION_SD_DAYS
  );
}

export interface PhaseInputs {
  cycles: readonly DerivedCycle[];
  /** Predicted start of the next cycle, from layer 1. */
  predictedNextStart: ISODate;
  /**
   * Last date the log still counts as current, from layer 1. Past it everything
   * anchored to the last logged start is stale. See `STALE_PREDICTIVE_QUANTILE`
   * and `STALE_MIN_MISSED_CYCLES` for how the bound is drawn.
   */
  predictionValidThrough: ISODate;
  /**
   * The day the model is being built for. Only `late` and `stale` depend on it,
   * and both are properties of where today sits relative to the prediction
   * rather than of any date being asked about.
   */
  today: ISODate;
  lutealLength: LearnedLength;
  periodLength: LearnedLength;
  confidence: number;
  confidenceTier: ConfidenceTier;
}

/** The windows of one cycle, given where it starts and where it ends. */
interface CycleWindows {
  cycleStart: ISODate;
  cycleEnd: ISODate;
  menstrual: DateRange;
  ovulation: ISODate;
  fertile: DateRange;
  premenstrual: DateRange;
}

function windowsFor(cycleStart: ISODate, cycleEnd: ISODate, inputs: PhaseInputs): CycleWindows {
  const periodDays = Math.max(1, roundDays(inputs.periodLength.meanDays));
  const lutealDays = Math.max(1, roundDays(inputs.lutealLength.meanDays));
  const ovulation = addDays(cycleEnd, -lutealDays);
  return {
    cycleStart,
    cycleEnd,
    menstrual: { start: cycleStart, end: addDays(cycleStart, periodDays - 1) },
    ovulation,
    fertile: {
      start: addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION),
      end: addDays(ovulation, FERTILE_DAYS_AFTER_OVULATION),
    },
    premenstrual: {
      start: addDays(cycleEnd, -PREMENSTRUAL_WINDOW_DAYS),
      end: addDays(cycleEnd, -1),
    },
  };
}

/**
 * Where today sits relative to the prediction.
 *
 * `stale` once today is past everything the model can account for, `late` from
 * the predicted start until then, `current` before it. All three are read off
 * `inputs.today` and never off a date being asked about: a calendar querying
 * next Tuesday is not evidence that anything has stopped.
 *
 * Only the in-progress cycle can be either. A completed cycle is bounded by a
 * real next start, so its windows are anchored to what happened rather than to
 * a prediction and stay correct forever.
 */
type LogState = 'current' | 'late' | 'stale';

function logStateOn(inputs: PhaseInputs, cycle: DerivedCycle): LogState {
  if (cycle.nextStartDate !== undefined) return 'current';
  if (compareDates(inputs.today, inputs.predictionValidThrough) > 0) return 'stale';
  return compareDates(inputs.today, inputs.predictedNextStart) >= 0 ? 'late' : 'current';
}

/** Days past the predicted start. Zero on the predicted day itself. */
function daysLateOn(inputs: PhaseInputs): number {
  return diffDays(inputs.predictedNextStart, inputs.today);
}

/**
 * The current cycle's windows, or an empty model when nothing has been logged.
 *
 * The current cycle runs from the last logged start to the predicted next
 * start.
 *
 * Once the predicted start has passed with nothing logged, the ovulation
 * estimate and the fertile and premenstrual windows are dropped rather than
 * relabelled, because all three are indexed backward from a cycle end that has
 * turned out to be wrong. Once the log is stale the menstrual window goes too.
 * The most likely reasons someone stops logging for months are pregnancy,
 * illness, or having given up on the app, and in all three a confidently
 * rendered fertile window from months ago is wrong. Suppressing it here means a
 * consumer cannot show one by forgetting to check a flag.
 */
export function buildPhaseModel(inputs: PhaseInputs): PhaseModel {
  const base = {
    lutealLength: inputs.lutealLength,
    periodLength: inputs.periodLength,
    fertilityIsEstimateNotContraception: true,
  } as const;

  const lastCycle = inputs.cycles[inputs.cycles.length - 1];
  if (lastCycle === undefined) {
    return { ...base, isLate: false, isStale: false };
  }

  const state = logStateOn(inputs, lastCycle);
  if (state === 'stale') {
    return { ...base, isLate: false, isStale: true };
  }

  const windows = windowsFor(lastCycle.startDate, inputs.predictedNextStart, inputs);
  if (state === 'late') {
    return {
      ...base,
      menstrualWindow: windows.menstrual,
      isLate: true,
      daysLate: daysLateOn(inputs),
      isStale: false,
    };
  }
  return {
    ...base,
    estimatedOvulationDate: windows.ovulation,
    fertileWindow: windows.fertile,
    premenstrualWindow: windows.premenstrual,
    menstrualWindow: windows.menstrual,
    isLate: false,
    isStale: false,
  };
}

/**
 * The cycle a date falls in.
 *
 * Historical cycles have a real next start, so their windows are anchored to
 * what actually happened. Only the current cycle is anchored to a prediction.
 */
function enclosingCycle(cycles: readonly DerivedCycle[], date: ISODate): DerivedCycle | undefined {
  let found: DerivedCycle | undefined;
  for (const cycle of cycles) {
    if (compareDates(cycle.startDate, date) > 0) break;
    found = cycle;
  }
  return found;
}

/**
 * The five phases a day can sit in when there is a cycle to place it in. `late`
 * and `stale` are states of the log rather than of the cycle, so they are not
 * reachable from the windows and have their own wording below.
 */
type CycleWindowPhase = Exclude<CyclePhase, 'late' | 'stale'>;

function cycleSummary(phase: CycleWindowPhase, windows: CycleWindows, dayOfCycle: number): string {
  switch (phase) {
    case 'menstrual':
      return `Day ${dayOfCycle}. Period.`;
    case 'follicular':
      return `Day ${dayOfCycle}. Follicular phase, between the period and the fertile window.`;
    case 'fertile':
      return `Day ${dayOfCycle}. Estimated fertile window, ${windows.fertile.start} to ${windows.fertile.end}, around an estimated ovulation on ${windows.ovulation}. Ovulation is inferred from cycle length only, not observed. This is an estimate and not contraception.`;
    case 'luteal':
      return `Day ${dayOfCycle}. Luteal phase, after the estimated fertile window.`;
    case 'premenstrual':
      return `Day ${dayOfCycle}. The last few days before the period is expected on ${windows.cycleEnd}.`;
  }
}

/**
 * Both of these say only what the engine knows: a date passed and nothing was
 * logged. They never reach for a reason. She may be late, she may have missed a
 * log, she may be pregnant, and start dates cannot tell those apart, so naming
 * one or hinting at one would be the app guessing at her life.
 */
function lateSummary(daysLate: number, windows: CycleWindows, dayOfCycle: number): string {
  if (daysLate === 0) {
    return `Your period is due today, ${windows.cycleEnd}. Nothing logged yet. Day ${dayOfCycle}, counting from your last logged start on ${windows.cycleStart}.`;
  }
  const days = daysLate === 1 ? '1 day' : `${daysLate} days`;
  return `${days} past the ${windows.cycleEnd} estimate, with no period start logged since ${windows.cycleStart}. Day ${dayOfCycle} counting from that start.`;
}

function staleSummary(windows: CycleWindows, today: ISODate): string {
  return `Your last logged period start was ${windows.cycleStart}, ${diffDays(windows.cycleStart, today)} days ago, which is further back than this estimate reaches. There is no current cycle to report. Log a period start, either one you missed or your next one, and this will pick up again.`;
}

function classify(date: ISODate, windows: CycleWindows): CycleWindowPhase {
  if (isWithin(date, windows.menstrual.start, windows.menstrual.end)) return 'menstrual';
  if (isWithin(date, windows.fertile.start, windows.fertile.end)) return 'fertile';
  if (isWithin(date, windows.premenstrual.start, windows.premenstrual.end)) return 'premenstrual';
  return compareDates(date, windows.ovulation) > 0 ? 'luteal' : 'follicular';
}

/**
 * Phase for any date on or after the first logged period start.
 *
 * Returns undefined before the first logged start, and past the end of what the
 * current model describes, where there is genuinely nothing to say.
 *
 * `late` and `stale` describe today, not the date being asked about, so a
 * calendar drawing next month off this function gets ordinary phases for those
 * days while today gets the one honest answer about the state of the log. The
 * two exceptions are deliberate. Past the predicted start only the predicted
 * bleed itself is claimed for a non-today date, since a cycle whose start has
 * not happened cannot place anything after it. And once the log is stale the
 * predicted windows are withheld for every date in the in-progress cycle, not
 * only for today, because they belong to a cycle that did not happen and
 * offering them per-day would be the fertile window suppression undone one cell
 * at a time. What survives there is the bleed anchored to the real logged start.
 */
export function phaseForDate(inputs: PhaseInputs, date: ISODate): PhaseEstimate | undefined {
  const cycle = enclosingCycle(inputs.cycles, date);
  if (cycle === undefined) return undefined;

  const cycleEnd = cycle.nextStartDate ?? inputs.predictedNextStart;
  const windows = windowsFor(cycle.startDate, cycleEnd, inputs);
  const dayOfCycle = diffDays(cycle.startDate, date) + 1;
  const state = logStateOn(inputs, cycle);

  const estimate = {
    date,
    confidence: inputs.confidence,
    confidenceTier: inputs.confidenceTier,
    fertilityIsEstimateNotContraception: true,
  } as const;

  if (state === 'stale') {
    if (isWithin(date, windows.menstrual.start, windows.menstrual.end)) {
      return {
        ...estimate,
        phase: 'menstrual',
        dayOfCycle,
        summary: cycleSummary('menstrual', windows, dayOfCycle),
      };
    }
    return { ...estimate, phase: 'stale', summary: staleSummary(windows, inputs.today) };
  }

  if (state === 'late' && date === inputs.today) {
    const daysLate = daysLateOn(inputs);
    return {
      ...estimate,
      phase: 'late',
      dayOfCycle,
      daysLate,
      summary: lateSummary(daysLate, windows, dayOfCycle),
    };
  }

  if (cycle.nextStartDate === undefined && compareDates(date, cycleEnd) >= 0) {
    const periodDays = Math.max(1, roundDays(inputs.periodLength.meanDays));
    if (!isWithin(date, cycleEnd, addDays(cycleEnd, periodDays - 1))) return undefined;
    const dayOfPredictedCycle = diffDays(cycleEnd, date) + 1;
    return {
      ...estimate,
      phase: 'menstrual',
      dayOfCycle: dayOfPredictedCycle,
      summary: cycleSummary('menstrual', windows, dayOfPredictedCycle),
    };
  }

  const phase = classify(date, windows);
  return {
    ...estimate,
    phase,
    dayOfCycle,
    summary: cycleSummary(phase, windows, dayOfCycle),
  };
}
