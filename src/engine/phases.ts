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
   * Last date the current cycle's windows still describe, which is the far end
   * of the prediction's own 80% interval. Past it the model has been
   * contradicted by the calendar and everything anchored to the last logged
   * start is stale. Taking the bound from the interval rather than a fixed
   * number of days means a regular history gives up on itself sooner than a
   * variable one, which is the right way round.
   */
  predictionValidThrough: ISODate;
  /** The day the model is being built for. Only staleness depends on it. */
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
 * True when `date` sits past everything the current cycle's model can account
 * for.
 *
 * Only the in-progress cycle can go stale. A completed cycle is bounded by a
 * real next start, so its windows are anchored to what happened rather than to
 * a prediction and stay correct forever.
 */
function isStaleOn(inputs: PhaseInputs, cycle: DerivedCycle, date: ISODate): boolean {
  return cycle.nextStartDate === undefined && compareDates(date, inputs.predictionValidThrough) > 0;
}

/**
 * The current cycle's windows, or an empty model when nothing has been logged.
 *
 * The current cycle runs from the last logged start to the predicted next
 * start.
 *
 * When the log has gone stale every window is dropped rather than relabelled.
 * The most likely reasons someone stops logging for months are pregnancy,
 * illness, or having given up on the app, and in all three a confidently
 * rendered fertile window from months ago is wrong. Suppressing it here means a
 * consumer cannot show one by forgetting to check a flag.
 */
export function buildPhaseModel(inputs: PhaseInputs): PhaseModel {
  const lastCycle = inputs.cycles[inputs.cycles.length - 1];
  if (lastCycle === undefined) {
    return {
      lutealLength: inputs.lutealLength,
      periodLength: inputs.periodLength,
      isStale: false,
      fertilityIsEstimateNotContraception: true,
    };
  }
  if (isStaleOn(inputs, lastCycle, inputs.today)) {
    return {
      lutealLength: inputs.lutealLength,
      periodLength: inputs.periodLength,
      isStale: true,
      fertilityIsEstimateNotContraception: true,
    };
  }
  const windows = windowsFor(lastCycle.startDate, inputs.predictedNextStart, inputs);
  return {
    lutealLength: inputs.lutealLength,
    periodLength: inputs.periodLength,
    estimatedOvulationDate: windows.ovulation,
    fertileWindow: windows.fertile,
    premenstrualWindow: windows.premenstrual,
    menstrualWindow: windows.menstrual,
    isStale: false,
    fertilityIsEstimateNotContraception: true,
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

function phaseSummary(phase: CyclePhase, windows: CycleWindows, dayOfCycle: number): string {
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
    case 'stale':
      // Deliberately says nothing about why. She may be late, she may have
      // missed a log, she may be pregnant. The engine cannot tell those apart
      // from start dates, so it names only what it does know.
      return `Day ${dayOfCycle}. Your last logged period start was ${windows.cycleStart}, further back than this estimate reaches, so there is nothing current to report. Log a period start, either one you missed or your next one, and this will pick up again.`;
  }
}

function classify(date: ISODate, windows: CycleWindows): CyclePhase {
  if (isWithin(date, windows.menstrual.start, windows.menstrual.end)) return 'menstrual';
  if (isWithin(date, windows.fertile.start, windows.fertile.end)) return 'fertile';
  if (isWithin(date, windows.premenstrual.start, windows.premenstrual.end)) return 'premenstrual';
  return compareDates(date, windows.ovulation) > 0 ? 'luteal' : 'follicular';
}

/**
 * Phase for any date on or after the first logged period start.
 *
 * Returns undefined before the first logged start, where there is genuinely
 * nothing to say.
 *
 * Three cases past the predicted next start, in order of how far past it is.
 * Inside the predicted range the day is reported as menstrual: the period is
 * expected, and saying "overdue" would overstate how precisely the engine knows
 * anything. Past the far end of the 80% interval that reasoning runs out, since
 * the model's own claim has been contradicted, and the day is `stale` instead.
 * Reporting "Day 127. Period." after four months of silence is a plainly false
 * statement, and it is a worse failure than the overdue claim the menstrual case
 * exists to avoid.
 */
export function phaseForDate(inputs: PhaseInputs, date: ISODate): PhaseEstimate | undefined {
  const cycle = enclosingCycle(inputs.cycles, date);
  if (cycle === undefined) return undefined;

  const cycleEnd = cycle.nextStartDate ?? inputs.predictedNextStart;
  const windows = windowsFor(cycle.startDate, cycleEnd, inputs);
  const dayOfCycle = diffDays(cycle.startDate, date) + 1;

  let phase: CyclePhase;
  if (isStaleOn(inputs, cycle, date)) {
    phase = 'stale';
  } else if (cycle.nextStartDate === undefined && compareDates(date, cycleEnd) >= 0) {
    phase = 'menstrual';
  } else {
    phase = classify(date, windows);
  }

  return {
    date,
    phase,
    dayOfCycle,
    confidence: inputs.confidence,
    confidenceTier: inputs.confidenceTier,
    fertilityIsEstimateNotContraception: true,
    summary: phaseSummary(phase, windows, dayOfCycle),
  };
}
