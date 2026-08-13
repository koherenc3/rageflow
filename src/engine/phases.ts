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
  MAX_FITTABLE_PERIOD_LENGTH_DAYS,
  PERIOD_OBSERVATION_SD_DAYS,
  PERIOD_PRIOR_MEAN_DAYS,
  PERIOD_PRIOR_SD_DAYS,
  PREMENSTRUAL_WINDOW_DAYS,
} from './constants';
import {
  addDays,
  compareDates,
  diffDays,
  isWithin,
  maxDate,
  minDate,
  roundDays,
  type ISODate,
} from './date';
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
   * and `STALE_MIN_ELAPSED_CYCLES` for how the bound is drawn.
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

/**
 * The windows of one cycle, given where it starts and where it ends.
 *
 * They are disjoint by construction. `fertility` and `premenstrual` are absent
 * when an earlier window has taken every day they would have covered, or when
 * the state of the log means the engine cannot stand behind them, which is why
 * both are optional here and on `PhaseModel`.
 */
interface CycleWindows {
  cycleStart: ISODate;
  cycleEnd: ISODate;
  /**
   * Learned bleed length in whole days, rounded once for every reader.
   *
   * It measures the bleed the engine predicts, never one it has been told
   * about: `menstrual` uses it only for a cycle she logged no end for.
   */
  predictedBleedDays: number;
  /**
   * The span the bleed of this cycle occupies: from the logged start to the
   * logged end when she recorded one, and to the learned length when she did
   * not, with the part of that reaching past today bounded by
   * `MAX_FITTABLE_PERIOD_LENGTH_DAYS` and by the next start the engine expects.
   * Every other window of this cycle is laid out around it and it is never
   * published, because it can name days that have not happened. The days it
   * names that have not happened report `predicted-menstrual`, which is the
   * phase for a bleed day the engine expects rather than one it was told about.
   */
  bleedSpan: DateRange;
  /**
   * The bleed of this cycle as the engine is willing to assert it, which is
   * `bleedSpan` with everything after today taken off the back of it. This is
   * the range that is published and the range a day is tested against.
   *
   * Absent when the whole span is still ahead of today, since a bleed the
   * engine cannot claim a single day of is no bleed to report.
   */
  menstrual?: DateRange;
  /**
   * The estimated ovulation day. Always computed, because the follicular and
   * luteal halves of the cycle are read off it, and never handed out on its own:
   * what a consumer sees is `fertility`, which carries it.
   */
  ovulationDay: ISODate;
  /**
   * The fertile window and the ovulation estimate inside it, in one field so
   * that publishing either without the other is not expressible. On a short
   * cycle with a long bleed the bleed can take the ovulation day and the days
   * around it, and an ovulation marker on a day the engine calls period, or a
   * fertile window with no ovulation left in it, are both a model disagreeing
   * with itself.
   */
  fertility?: { range: DateRange; ovulationDay: ISODate };
  premenstrual?: DateRange;
}

/**
 * A window with everything up to and including `claimed` taken out of it, or
 * nothing at all when that leaves it empty.
 */
function after(range: DateRange, claimed: ISODate): DateRange | undefined {
  const start = compareDates(range.start, claimed) > 0 ? range.start : addDays(claimed, 1);
  return compareDates(start, range.end) > 0 ? undefined : { start, end: range.end };
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

/**
 * The windows, laid out so they cannot overlap and so that nothing the engine
 * cannot stand behind is laid out at all.
 *
 * The bleed is the one window that can be a fact. When she logged an end date
 * for this cycle it runs from her start to her end, exactly as she typed them,
 * and the learned length is not consulted at all: that parameter exists to
 * predict the cycles she has not described, and using it over one she has would
 * be the engine reporting an estimate on top of a recorded fact. It governs the
 * cycles with no logged end, and the bleed the engine expects next, and nothing
 * else.
 *
 * A logged end is taken at face value for the days of it that have arrived,
 * including one that is longer than any plausible period.
 * `MAX_FITTABLE_PERIOD_LENGTH_DAYS` keeps a mistyped entry out of the fit and
 * deliberately does not clamp what is shown of the days that have happened; see
 * `docs/DECISIONS.md`.
 *
 * The bleed does two jobs here and they are two different questions, so it is
 * two values. Answering both with one range is what put a fertile window inside
 * a span she had recorded as a period.
 *
 * - THE RECORDED BLEED SPAN GOVERNS LAYOUT. She recorded those days as a
 *   period, so nothing else may claim them. `bleedSpan` runs to the end she
 *   typed, and the fertile and premenstrual cuts are taken against it, so an end
 *   date typed for a day that has not arrived suppresses the fertility estimate
 *   over every day of it the span reaches, exactly as one typed for a day that
 *   has.
 * - THE NEVER-PAST-TODAY RULE GOVERNS ASSERTION. The engine must not tell her
 *   she is bleeding tomorrow. `menstrual` is `bleedSpan` cut off at today, and
 *   it is the only one of the two that is published or that a day is tested
 *   against, in every state of the log and whether or not she logged an end.
 *   Showing a 22 day bleed that has already happened is showing her data as it
 *   is; saying she is bleeding on days that have not happened is a claim about
 *   the future, and a logged fact about the future is not a fact.
 *
 * The span itself is bounded past today for the same reason, and only past
 * today. Every day of it that has already elapsed is her data and is drawn at
 * whatever length she typed. The days of it that have not are the engine
 * projecting her entry forward, which is a claim about the future like any
 * other, so it is bounded like any other: `projectionEnd` stops at the longest
 * bleed the fit will accept, `MAX_FITTABLE_PERIOD_LENGTH_DAYS`, or at the day
 * before the next start the engine expects, whichever comes first. The bound is
 * the fit's rather than a second one tuned here, because how long a period can
 * plausibly run is one question and it has one answer. Without it a single
 * mistyped year reached eleven months forward in both of the jobs above, calling
 * every day of them a continuation of her bleed and suppressing the fertility
 * estimate across all of them. Both uses read the one bounded span, so neither
 * can be bounded without the other.
 *
 * So the days between today and the end of the span are laid out as bleed and
 * reported as `predicted-menstrual` until they arrive: a bleed day the engine
 * expects rather than one she recorded, which is what a day of her entry that
 * has not happened is. Her entry is not altered by any of that, and the day it
 * names becomes a period day the moment it comes round. The same cut applies to
 * a cycle she logged no end for, where the span is the learned length: that end
 * is an estimate rather than an entry, which is if anything less of a licence to
 * say she was bleeding on a day that has not happened.
 *
 * The bleed is indexed forward from the cycle start and the fertile window
 * backward from the cycle end, so on a short cycle with a long period the two
 * collide: a 23 day cycle with a 7 day bleed puts days 6 and 7 in both.
 * They are cut apart here, once, in the order the day is read in: a day she is
 * bleeding is a period day whatever else the arithmetic says about it, and a
 * fertile day beats the premenstrual run-up for the same reason, which is that
 * it is the more specific claim.
 *
 * The cut can go further than trimming the front. A short enough cycle puts the
 * estimated ovulation day itself inside the bleed, and what is left of the
 * fertile window then is the tail of a window whose middle the engine says she
 * bled through. There is no fertility estimate to publish in that case, so none
 * is: it is dropped whole rather than handed back as a stray day, or as an
 * ovulation marker sitting on a period day.
 *
 * The state of the log is applied here too. Everything indexed backward from the
 * cycle end is dropped once that end has been contradicted, which is why `late`
 * and `stale` get the bleed and nothing else.
 *
 * Doing both here rather than when a day is looked up is what keeps the two
 * outputs honest. The windows this returns for the current cycle are the only
 * windows that cycle has: `buildPhaseModel` publishes exactly these and
 * `phaseForDate` classifies its days against exactly these, in every state of
 * the log. `PhaseModel` states that agreement and its domain in full, including
 * why a completed cycle sits outside it.
 */
function windowsFor(cycle: DerivedCycle, inputs: PhaseInputs, state: LogState): CycleWindows {
  const cycleStart = cycle.startDate;
  // A completed cycle ends where the next one she logged began; the in-progress
  // one ends where the prediction puts it. Derived here so the windows and every
  // reader of them cannot disagree about where the cycle stops.
  const cycleEnd = cycle.nextStartDate ?? inputs.predictedNextStart;
  const predictedBleedDays = Math.max(1, roundDays(inputs.periodLength.meanDays));
  const lutealDays = Math.max(1, roundDays(inputs.lutealLength.meanDays));
  const ovulationDay = addDays(cycleEnd, -lutealDays);
  const loggedEnd = cycle.endDate;
  const recordedEnd =
    loggedEnd === undefined
      ? addDays(cycleStart, predictedBleedDays - 1)
      : maxDate(cycleStart, loggedEnd);
  const projectionEnd = minDate(
    addDays(cycleStart, MAX_FITTABLE_PERIOD_LENGTH_DAYS - 1),
    addDays(cycleEnd, -1)
  );
  const bleedSpan = {
    start: cycleStart,
    end: minDate(recordedEnd, maxDate(inputs.today, projectionEnd)),
  };
  const assertedEnd = minDate(bleedSpan.end, inputs.today);
  const menstrual =
    compareDates(assertedEnd, bleedSpan.start) < 0
      ? undefined
      : { start: bleedSpan.start, end: assertedEnd };
  const bleed = {
    cycleStart,
    cycleEnd,
    predictedBleedDays,
    bleedSpan,
    ...(menstrual === undefined ? {} : { menstrual }),
    ovulationDay,
  };
  if (state !== 'current') return bleed;

  const fertile = after(
    {
      start: addDays(ovulationDay, -FERTILE_DAYS_BEFORE_OVULATION),
      end: addDays(ovulationDay, FERTILE_DAYS_AFTER_OVULATION),
    },
    bleedSpan.end
  );
  const fertility =
    fertile !== undefined && isWithin(ovulationDay, fertile.start, fertile.end)
      ? { range: fertile, ovulationDay }
      : undefined;
  const premenstrual = after(
    { start: addDays(cycleEnd, -PREMENSTRUAL_WINDOW_DAYS), end: addDays(cycleEnd, -1) },
    fertility?.range.end ?? bleedSpan.end
  );
  return { ...bleed, fertility, premenstrual };
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
 * turned out to be wrong, and they stay dropped once the log goes stale. The
 * most likely reasons someone stops logging for months are pregnancy, illness,
 * or having given up on the app, and in all three a confidently rendered fertile
 * window from months ago is wrong. Suppressing it means a consumer cannot show
 * one by forgetting to check a flag. It happens in `windowsFor` rather than
 * here, so `phaseForDate` cannot hand back one calendar cell at a time what this
 * model has withheld for the cycle it describes.
 *
 * The menstrual window survives both states, because it is anchored to what she
 * typed rather than to a predicted end: a start she logged, and an end she
 * logged when she recorded one. It says a bleed began on a day she typed in,
 * which stays true however long the silence after it runs, and `phaseForDate`
 * reports the same days the same way. What is published is the part of it that
 * has happened, never the whole span the windows were laid out around, and it is
 * absent altogether in the one case where none of it has.
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
  const windows = windowsFor(lastCycle, inputs, state);
  // The bleed the engine will assert, never the span the windows were laid out
  // around: publishing the span would put a period on days that have not
  // happened, which is the one thing `windowsFor` separates the two values for.
  const menstrualWindow = windows.menstrual;
  if (state === 'stale') {
    return {
      ...base,
      ...(menstrualWindow === undefined ? {} : { menstrualWindow }),
      isLate: false,
      isStale: true,
    };
  }

  if (state === 'late') {
    return {
      ...base,
      ...(menstrualWindow === undefined ? {} : { menstrualWindow }),
      isLate: true,
      daysLate: daysLateOn(inputs),
      isStale: false,
    };
  }
  return {
    ...base,
    estimatedOvulationDate: windows.fertility?.ovulationDay,
    fertileWindow: windows.fertility?.range,
    premenstrualWindow: windows.premenstrual,
    ...(menstrualWindow === undefined ? {} : { menstrualWindow }),
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
 * The phases left once the bleed has been ruled out.
 *
 * The bleed is decided before anything else in `phaseForDate`, in one place, so
 * neither `menstrual` nor the `predicted-menstrual` tail of the same span can be
 * reached here. `late` and `stale` are states of the log rather than of the
 * cycle, and the rest of `predicted-menstrual` is the bleed the engine expects
 * next rather than one it has been told about, so none of those is reachable
 * from the windows either and each has its own wording below.
 */
type CycleWindowPhase = Exclude<CyclePhase, 'menstrual' | 'late' | 'stale' | 'predicted-menstrual'>;

/** The bleed she logged, from the start she typed to the end she typed. */
function menstrualSummary(dayOfCycle: number): string {
  return `Day ${dayOfCycle}. Period.`;
}

/**
 * Which window a day falls in, and the sentence for it, for a day the bleed has
 * not already claimed.
 *
 * One function rather than a classifier and a separate switch, so the phase a
 * day is given and the range quoted back to her are read off the same window.
 * The order the windows are tried in no longer decides anything, because
 * `windowsFor` has already cut them apart, but it is the same order for the
 * same reason.
 *
 * `follicular` and `luteal` are what is left when no window claims the day: the
 * halves either side of the ovulation estimate, which is a split rather than a
 * range and stays available whether or not the estimate itself can be published.
 * They are not the only two phases reachable with no fertile window. `menstrual`
 * always is, decided before this function is reached, and so is `premenstrual`
 * on a cycle short enough that the bleed swallowed the fertile window, because
 * that cut takes the window it collides with and leaves the run-up alone. It is
 * `late` that drops both windows together, so only there does having no fertile
 * window mean having no premenstrual one. The wording here names the fertile
 * window only when there is one to name.
 */
function describeCycleDay(
  date: ISODate,
  windows: CycleWindows,
  dayOfCycle: number
): { phase: CycleWindowPhase; summary: string } {
  const fertility = windows.fertility;
  if (fertility !== undefined && isWithin(date, fertility.range.start, fertility.range.end)) {
    return {
      phase: 'fertile',
      summary: `Day ${dayOfCycle}. Estimated fertile window, ${fertility.range.start} to ${fertility.range.end}, around an estimated ovulation on ${fertility.ovulationDay}. Ovulation is inferred from cycle length only, not observed. This is an estimate and not contraception.`,
    };
  }
  const premenstrual = windows.premenstrual;
  if (premenstrual !== undefined && isWithin(date, premenstrual.start, premenstrual.end)) {
    return {
      phase: 'premenstrual',
      summary: `Day ${dayOfCycle}. The last few days before the period is expected on ${windows.cycleEnd}.`,
    };
  }
  return compareDates(date, windows.ovulationDay) > 0
    ? {
        phase: 'luteal',
        summary:
          fertility === undefined
            ? `Day ${dayOfCycle}. Luteal phase, the second half of the cycle.`
            : `Day ${dayOfCycle}. Luteal phase, after the estimated fertile window.`,
      }
    : {
        phase: 'follicular',
        summary:
          fertility === undefined
            ? `Day ${dayOfCycle}. Follicular phase, after the period.`
            : `Day ${dayOfCycle}. Follicular phase, between the period and the fertile window.`,
      };
}

/**
 * A day inside the bleed the engine expects next, which has not happened yet.
 *
 * It is worth saying, because when the period is due is most of what this app
 * is for, but it is an estimate and has to read as one. A logged bleed says
 * "Day 2. Period." because she typed the start date in. This one names the date
 * it is indexed to and says nothing was logged for it, so the two cannot be
 * mistaken for each other from the sentence alone any more than they can from
 * the phase.
 */
function predictedBleedSummary(expectedStart: ISODate, dayOfBleed: number): string {
  return `Day ${dayOfBleed} of the period expected to start on ${expectedStart}. Nothing is logged for it yet, so this day is an estimate rather than a bleed you recorded.`;
}

/**
 * A day of the bleed of the cycle she is in, which the span reaches past today.
 *
 * The same phase as the sentence above and a different provenance, which is what
 * the wording carries: this day belongs to a period whose start she typed in,
 * rather than to one the engine is expecting from a cycle length. Naming that
 * start is the whole difference, and it is as far as the sentence goes. Her
 * entry says the bleed runs to a day that has not arrived, and an entry about a
 * day that has not happened is still not a record of it, so this says the day is
 * expected rather than that she is bleeding on it.
 *
 * It reads the same way for a cycle she logged no end for, where the span is the
 * learned length. That is a weaker claim about the same days and the sentence
 * does not have to distinguish it: neither version asserts the bleed, and both
 * name the start it is counted from, which is hers in both cases.
 */
function continuingBleedSummary(loggedStart: ISODate, dayOfCycle: number): string {
  return `Day ${dayOfCycle} of the period you logged starting on ${loggedStart}. This day has not arrived yet, so it is still expected rather than a day you have recorded bleeding on.`;
}

/**
 * Both of these say only what the engine knows: a date passed and nothing was
 * logged. They never reach for a reason. She may be late, she may have missed a
 * log, she may be pregnant, and start dates cannot tell those apart, so naming
 * one or hinting at one would be the app guessing at her life.
 *
 * Both are also statements about the day being asked about rather than about
 * today. Every day count in them is measured from that day, and the wording that
 * says "today" is used only when the two are the same day. The `late` state
 * reaches days other than today, so a sentence carrying today's count onto one of
 * them would put two frames of reference in one line: a cell for the day after
 * the estimate reading "6 days past" beside a day number that is its own.
 * `PhaseEstimate.daysLate` stays measured to today, because being late is a state
 * of the log rather than a property of a day, and it is documented as such.
 */
function lateSummary(
  windows: CycleWindows,
  dayOfCycle: number,
  daysPastEstimate: number,
  isToday: boolean
): string {
  if (daysPastEstimate === 0) {
    return isToday
      ? `Your period is due today, ${windows.cycleEnd}. Nothing logged yet. Day ${dayOfCycle}, counting from your last logged start on ${windows.cycleStart}.`
      : `Your period was expected on ${windows.cycleEnd} and nothing was logged. Day ${dayOfCycle}, counting from your last logged start on ${windows.cycleStart}.`;
  }
  const days = daysPastEstimate === 1 ? '1 day' : `${daysPastEstimate} days`;
  return `${days} past the ${windows.cycleEnd} estimate, with no period start logged since ${windows.cycleStart}. Day ${dayOfCycle} counting from that start.`;
}

function staleSummary(windows: CycleWindows, date: ISODate, isToday: boolean): string {
  const gapDays = diffDays(windows.cycleStart, date);
  const resume =
    'Log a period start, either one you missed or your next one, and this will pick up again.';
  return isToday
    ? `Your last logged period start was ${windows.cycleStart}, ${gapDays} days ago, which is further back than this estimate reaches. There is no current cycle to report. ${resume}`
    : `Your last logged period start was ${windows.cycleStart}, ${gapDays} days before this day, and nothing was logged after it, so there is no cycle to place this day in. ${resume}`;
}

/**
 * Phase for any date on or after the first logged period start.
 *
 * This comment is the contract. `docs/DECISIONS.md` records why it is drawn this
 * way and `docs/PLAN.md` summarises it for the UI; both defer here rather than
 * restating the reach, because three overlapping descriptions of one rule is how
 * this function drifted before.
 *
 * Returns undefined before the first logged start, and past the end of what the
 * log's own state lets the model describe, where there is genuinely nothing to
 * say. That end is a different date in each of the three states, and all three
 * rules are here, in full. `late` and `stale` are read off today, never off the
 * date being asked about, so a calendar querying next Tuesday is not evidence
 * that anything has stopped.
 *
 * All three rules are about the in-progress cycle, which is the only one a state
 * of the log can reach. A date inside a completed cycle is classified against
 * that cycle's own windows, laid out between two starts she logged, and today
 * cannot change what those days were: while late or stale such a day still comes
 * back `fertile` or `premenstrual` if that is what it was, and `buildPhaseModel`
 * publishes no window for it either way. `PhaseModel` states that division.
 *
 * Ahead of all three sits the bleed of the cycle the date falls in, which is
 * decided first and the same way in every state, and which of its two answers a
 * date gets is decided by today alone. A date inside it that has arrived reports
 * `menstrual`. That bleed runs to where she logged the period ending, and only
 * to where the learned length puts it when she logged no end, so a long logged
 * bleed is reported as the bleed she recorded rather than as the state of a
 * prediction it happens to run past. It stops at today in both of those cases,
 * so this is not a fourth way for a state to reach past today: a date after
 * today never reports `menstrual`, on the strength of an entry or of an
 * estimate. `windowsFor` draws that line, once, and lays the other windows out
 * around the whole bleed rather than around the part of it that has happened.
 *
 * The days between today and the end of that span report `predicted-menstrual`,
 * with `predictedBleedBasis` of `continues-logged-bleed`. They are days of a
 * bleed that has not happened, so they cannot be `menstrual`, and they are days
 * the layout has reserved as bleed, so nothing else may claim them either:
 * leaving them to the follicular or luteal split would have the engine
 * contradict an entry she typed in herself. There are only ever such days while
 * the log is `current`, because `windowsFor` stops the span short of the next
 * start the engine expects, and `late` and `stale` are both states today has
 * already reached that start in. So this is not a fourth way for a state to
 * reach past today either: the whole of the reach past today is the `current`
 * bullet below, and every day of it is a day the engine expects a bleed on.
 *
 * - While the log is `current`, every date up to the last day of the bleed the
 *   engine expects next reports a phase, and dates past that return undefined.
 *   Days from the predicted start onward report `predicted-menstrual` with a
 *   basis of `expected-next-bleed`, which with the continuation above is the
 *   whole of what this function claims about days that have not happened, and is
 *   named so neither can be read as a bleed she logged.
 * - While today is `late`, dates from the predicted start through today report
 *   `late`, dates after today return undefined, and dates between the last
 *   logged start and the predicted start keep their ordinary phase, read off the
 *   windows the model still holds. It holds no fertile or premenstrual window
 *   while late, so those days of this cycle come back `menstrual`, `follicular`
 *   or `luteal` and never `fertile` or `premenstrual`.
 * - While today is `stale`, dates from the last logged start through today report
 *   `stale` except inside the logged bleed, which reports `menstrual`, and dates
 *   after today return undefined on the same terms.
 *
 * A bleed she logged an end for can still cover the predicted start and the days
 * after it, once those days have arrived, and then it is the bleed she recorded
 * that they report. The days of the bleed expected next are numbered from the
 * predicted start rather than from the first of them this function hands back,
 * so it is worth saying that the two cannot come apart: `expected-next-bleed` is
 * reported only while the log is `current`, which is a state today has not
 * reached the predicted start in, and the bleed of the cycle she is in is not
 * projected as far as that start, so neither answer can take a day from the
 * front of that run. It begins at day 1 or it does not begin, and a calendar
 * drawing a day-N-of-M ring for it can rely on that.
 *
 * Neither `late` nor `stale` reaches past today, because a cycle whose start has
 * not happened cannot place anything after it, and a model with no credible cycle
 * end has nothing to say about tomorrow. Both stay contiguous up to today, so a
 * consumer drawing a month gets a run of cells rather than a scatter of them.
 * Neither claims the bleed the engine predicted and then watched not arrive: once
 * that date has passed with nothing logged, the prediction is spent, and painting
 * those days as a period would contradict the same model's report on today.
 *
 * The one asymmetry between the two is deliberate. `late` leaves the days before
 * the predicted start with a phase, because nothing has contradicted the cycle
 * they belong to: it ran as predicted right up to the day the period was due.
 * `stale` reports them as `stale` instead, because once the silence has run past
 * everything the model can account for, the readings for those days were indexed
 * off a predicted cycle end now known not to have held, and offering them would
 * be handing back a falsified prediction one calendar cell at a time.
 *
 * Which phase those days get and whether they get one at all are two separate
 * questions, and `late` answers them differently. It keeps the days, and it
 * withholds the fertile reading among them, because the fertile window is
 * indexed backward from the cycle end that has just failed to arrive while the
 * day itself is not. That is the same suppression `buildPhaseModel` performs,
 * arrived at through the same windows, and it narrows what `late` reports on
 * those days rather than contradicting the rule that it reports on them.
 *
 * What survives every state is the bleed anchored to what she logged, which is
 * what `buildPhaseModel` keeps as `menstrualWindow`. A logged bleed is a fact and
 * a predicted window is not, and that is the whole rule. It is why the bleed is
 * decided before the state of the log is, and why it ends where she said it
 * ended. It is also why the predicted bleed of a current log is its own phase
 * rather than `menstrual`: the engine is entitled to say a period is expected on
 * Tuesday, and not entitled to say she was bleeding on a Tuesday that has not
 * arrived. Neither an end date typed for next Tuesday nor a learned length that
 * reaches it buys that entitlement, which is why the one bound on the reported
 * bleed is today.
 */
export function phaseForDate(inputs: PhaseInputs, date: ISODate): PhaseEstimate | undefined {
  const cycle = enclosingCycle(inputs.cycles, date);
  if (cycle === undefined) return undefined;

  const state = logStateOn(inputs, cycle);
  const windows = windowsFor(cycle, inputs, state);
  const dayOfCycle = diffDays(cycle.startDate, date) + 1;

  const estimate = {
    date,
    confidence: inputs.confidence,
    confidenceTier: inputs.confidenceTier,
    fertilityIsEstimateNotContraception: true,
  } as const;

  const menstrual = windows.menstrual;
  if (menstrual !== undefined && isWithin(date, menstrual.start, menstrual.end)) {
    return {
      ...estimate,
      phase: 'menstrual',
      dayOfCycle,
      summary: menstrualSummary(dayOfCycle),
    };
  }

  const bleedSpan = windows.bleedSpan;
  if (isWithin(date, bleedSpan.start, bleedSpan.end)) {
    return {
      ...estimate,
      phase: 'predicted-menstrual',
      dayOfCycle,
      predictedBleedBasis: 'continues-logged-bleed',
      summary: continuingBleedSummary(windows.cycleStart, dayOfCycle),
    };
  }

  if (state === 'stale') {
    if (compareDates(date, inputs.today) > 0) return undefined;
    return {
      ...estimate,
      phase: 'stale',
      summary: staleSummary(windows, date, date === inputs.today),
    };
  }

  if (state === 'late' && compareDates(date, windows.cycleEnd) >= 0) {
    if (compareDates(date, inputs.today) > 0) return undefined;
    return {
      ...estimate,
      phase: 'late',
      dayOfCycle,
      daysLate: daysLateOn(inputs),
      summary: lateSummary(
        windows,
        dayOfCycle,
        diffDays(windows.cycleEnd, date),
        date === inputs.today
      ),
    };
  }

  if (cycle.nextStartDate === undefined && compareDates(date, windows.cycleEnd) >= 0) {
    const predictedBleedEnd = addDays(windows.cycleEnd, windows.predictedBleedDays - 1);
    if (compareDates(date, predictedBleedEnd) > 0) return undefined;
    const dayOfPredictedBleed = diffDays(windows.cycleEnd, date) + 1;
    return {
      ...estimate,
      phase: 'predicted-menstrual',
      dayOfCycle: dayOfPredictedBleed,
      predictedBleedBasis: 'expected-next-bleed',
      summary: predictedBleedSummary(windows.cycleEnd, dayOfPredictedBleed),
    };
  }

  const { phase, summary } = describeCycleDay(date, windows, dayOfCycle);
  return { ...estimate, phase, dayOfCycle, summary };
}
