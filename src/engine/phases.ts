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
 * The current cycle's windows, or an empty model when nothing has been logged.
 *
 * The current cycle runs from the last logged start to the predicted next
 * start.
 */
export function buildPhaseModel(inputs: PhaseInputs): PhaseModel {
  const lastCycle = inputs.cycles[inputs.cycles.length - 1];
  if (lastCycle === undefined) {
    return {
      lutealLength: inputs.lutealLength,
      periodLength: inputs.periodLength,
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
 * nothing to say. Dates at or beyond the predicted next start are reported as
 * menstrual: the period is expected, and saying "overdue" would overstate how
 * precisely the engine knows anything.
 */
export function phaseForDate(inputs: PhaseInputs, date: ISODate): PhaseEstimate | undefined {
  const cycle = enclosingCycle(inputs.cycles, date);
  if (cycle === undefined) return undefined;

  const cycleEnd = cycle.nextStartDate ?? inputs.predictedNextStart;
  const windows = windowsFor(cycle.startDate, cycleEnd, inputs);
  const dayOfCycle = diffDays(cycle.startDate, date) + 1;

  const phase: CyclePhase =
    cycle.nextStartDate === undefined && compareDates(date, cycleEnd) >= 0
      ? 'menstrual'
      : classify(date, windows);

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
