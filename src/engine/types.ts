import type { ISODate } from './date';

/**
 * The data model.
 *
 * Two rules shape it.
 *
 * 1. The log is a flat list of dated entries, each tagged with a `kind`. Adding
 *    symptom or mood logging later means adding a new `kind`, not changing the
 *    shape of anything already written. Nothing in v1 is implemented beyond
 *    period start and period end.
 * 2. A cycle is derived, never stored. Cycles are the interval between
 *    consecutive starts, so storing them would let them drift out of sync with
 *    the only thing she actually typed. Correcting a mistyped start date has to
 *    silently correct every cycle around it.
 */

/** Kinds of day entry the engine understands today. */
export type DayEntryKind = 'period-start' | 'period-end';

/**
 * One logged fact about one calendar day.
 *
 * `meta` is an open bag for forward compatibility. Readers must preserve keys
 * they do not recognise so an older build cannot destroy data written by a
 * newer one.
 */
export interface DayEntry {
  date: ISODate;
  kind: DayEntryKind;
  meta?: Readonly<Record<string, unknown>>;
}

/** The entire persisted document. Storage lands in task 2. */
export interface CycleLog {
  /** Bumped only for changes that older readers cannot handle. */
  version: 1;
  entries: readonly DayEntry[];
}

/** Reasons a cycle is worth mentioning to a clinician. Never a diagnosis. */
export type ClinicalFlag = 'unusually-short' | 'unusually-long';

/**
 * One cycle, derived from consecutive period starts.
 *
 * The final cycle in a log is in progress: it has a start and no next start, so
 * no length.
 */
export interface DerivedCycle {
  /** Zero-based position in the log, oldest first. */
  index: number;
  startDate: ISODate;
  /** Start of the following cycle. Absent for the in-progress cycle. */
  nextStartDate?: ISODate;
  /** Days from this start to the next. Absent for the in-progress cycle. */
  lengthDays?: number;
  /** Logged last day of bleeding, when she recorded one. */
  endDate?: ISODate;
  /**
   * Inclusive bleed length in days, when an end date was logged. Reported
   * exactly as logged; an implausibly long one is kept here and left out of the
   * fit by `observedPeriodLengths`.
   */
  periodLengthDays?: number;
  /** True when this gap looks like two cycles with a missed start log. */
  suspectedMissedLog: boolean;
  /** Populated only for cycles with a known length that is not a suspected skip. */
  clinicalFlags: readonly ClinicalFlag[];
}

/** Posterior of the Normal-Inverse-Gamma model over cycle length. */
export interface CycleLengthPosterior {
  /** Observations that made it into the fit (suspected skips excluded). */
  observationCount: number;
  /** Sum of recency weights. The model's effective sample size. */
  weightSum: number;
  /**
   * Recency half life this fit used, in cycles.
   *
   * Carried on the posterior because `weightSum` is only interpretable against
   * it: the attainable maximum is a function of the half life, so anything
   * scaling against that maximum has to read the half life from the same fit
   * rather than assume the default.
   */
  halfLife: number;
  mu: number;
  kappa: number;
  alpha: number;
  beta: number;
  /** Student-t posterior predictive over the next cycle length. */
  predictive: StudentTPredictive;
}

export interface StudentTPredictive {
  degreesOfFreedom: number;
  location: number;
  scale: number;
  /** Standard deviation of the predictive. `Infinity` at df <= 2. */
  standardDeviation: number;
}

/** How much the engine claims to know. Driven by data volume, not by wording. */
export type ConfidenceTier = 'none' | 'low' | 'moderate' | 'high';

/** A closed date range, both ends inclusive. */
export interface DateRange {
  start: ISODate;
  end: ISODate;
}

export interface CredibleInterval {
  /** Nominal coverage, e.g. 0.8. */
  level: number;
  range: DateRange;
  /** Inclusive width in days. */
  widthDays: number;
}

/**
 * The dates the model computed for the next start, before anything is withheld.
 *
 * Every field is populated, always. This is what calibration grades and what the
 * phase model is anchored to, both of which need the raw numbers whatever state
 * the log is in. What a consumer is allowed to show is
 * {@link NextStartPrediction}.
 */
export interface NextStartEstimate {
  /** Most recent logged start the estimate is anchored to. Absent with an empty log. */
  lastStartDate?: ISODate;
  /** Point estimate. Always presented alongside the intervals, never alone. */
  pointDate: ISODate;
  /** Expected cycle length in days, unrounded. */
  expectedCycleLengthDays: number;
  interval50: CredibleInterval;
  interval80: CredibleInterval;
  /**
   * Last day this estimate still describes a current cycle. Past it the log has
   * gone quiet for longer than the model can account for. See
   * `STALE_PREDICTIVE_QUANTILE` and `STALE_MIN_ELAPSED_CYCLES`.
   */
  validThrough: ISODate;
  /** Multiplier applied to the raw intervals by calibration. 1 when untouched. */
  appliedWidenFactor: number;
  confidence: number;
  confidenceTier: ConfidenceTier;
  /** False until at least one of her own cycles is in the fit. */
  personalized: boolean;
}

interface NextStartPredictionCommon {
  lastStartDate?: ISODate;
  /** Expected cycle length in days, unrounded. */
  expectedCycleLengthDays: number;
  appliedWidenFactor: number;
  confidence: number;
  confidenceTier: ConfidenceTier;
  personalized: boolean;
  /**
   * Sentence describing how much history this prediction rests on, already
   * included at the end of `summary`. Carried as its own field so a consumer, and
   * `CycleAnalysis`, can read it off the prediction instead of deriving it a
   * second time from the same inputs and risking two different sentences.
   */
  coldStartMessage: string;
  /** Plain sentence the UI can show verbatim. */
  summary: string;
}

/**
 * A prediction that still describes a period that has not happened yet.
 *
 * "Not yet" is measured by its own 80% interval rather than by the point date.
 * A period arriving a day or two after the most likely date is what the interval
 * is for, and going quiet the moment the point date passes would throw away the
 * range the engine went to the trouble of computing.
 */
export interface CurrentNextStartPrediction extends NextStartPredictionCommon {
  isLate: false;
  isStale: false;
  pointDate: ISODate;
  interval50: CredibleInterval;
  interval80: CredibleInterval;
}

/**
 * A prediction the calendar has outlived: today is past the far end of its own
 * 80% interval and nothing has been logged since.
 *
 * The date the engine named survives as `expectedDate`, which is named for the
 * tense it is now in, and both intervals are dropped. Every day in them is in
 * the past, so a range offered as when the period is due would be a plain false
 * statement, while the date that did not happen is still worth reporting.
 */
export interface LateNextStartPrediction extends NextStartPredictionCommon {
  isLate: true;
  isStale: false;
  /** A late prediction is always anchored to a real logged start. */
  lastStartDate: ISODate;
  /** The date the period was expected. Always in the past here. */
  expectedDate: ISODate;
  /** Days from `expectedDate` to today. Always at least one. */
  daysLate: number;
}

/**
 * A prediction whose period did not arrive, or arrived and was not logged, for
 * longer than the model can account for.
 *
 * The dates are gone rather than flagged. Every one of them is in the past, so
 * `pointDate` bound to "next period" would render a date from months ago, and a
 * boolean beside it only prevents that for a consumer who remembers to read the
 * boolean. Discriminating the union on `isStale` and `isLate` means the compiler
 * stops anyone who does not.
 */
export interface StaleNextStartPrediction extends NextStartPredictionCommon {
  isLate: false;
  isStale: true;
  /** The stale prediction is always anchored to a real logged start. */
  lastStartDate: ISODate;
}

/**
 * The prediction for the next period start.
 *
 * `isLate` is on every variant rather than only on the one it is true for, so a
 * consumer reads the state of the log off the prediction itself instead of
 * pairing it with `PhaseModel.isLate` by convention. The two are drawn at
 * different points on purpose and cannot contradict each other: the phase model
 * is late from the predicted day, the prediction only once the whole 80% range
 * has run out, so a late prediction always sits inside a late phase model.
 */
export type NextStartPrediction =
  CurrentNextStartPrediction | LateNextStartPrediction | StaleNextStartPrediction;

/** A learned scalar with a Gaussian prior. */
export interface LearnedLength {
  meanDays: number;
  sdDays: number;
  /** Observations folded in. Zero means this is still the untouched prior. */
  observationCount: number;
  /** True while no observation has moved it off the prior. */
  isPrior: boolean;
}

/**
 * Where a day sits in the cycle.
 *
 * The first five are phases of a cycle the engine can place the day in. The last
 * three are not, and each is a different thing the engine says instead.
 *
 * `predicted-menstrual` is a day of the bleed expected next, which has not
 * happened. `menstrual` is a day of a bleed she logged the start of. The
 * difference is the difference between a fact and a prediction, and it is a
 * separate member rather than a flag beside `menstrual` for the same reason the
 * other two are members: a flag can be ignored, and a day the engine merely
 * expects must never render as a period she recorded.
 *
 * `late` means the predicted start has arrived or passed and no new start has
 * been logged. That is the whole claim: the engine knows the date it predicted
 * and knows nothing came in, and it says exactly that.
 *
 * `stale` means the silence has run past everything the model can account for,
 * so there is no current cycle to place the day in at all.
 *
 * All three are in this union rather than sitting beside it as flags, so an
 * exhaustive switch over the phases stops compiling until a consumer handles
 * them and none can be rendered as an ordinary phase by omission.
 */
export type CyclePhase =
  | 'menstrual'
  | 'predicted-menstrual'
  | 'follicular'
  | 'fertile'
  | 'luteal'
  | 'premenstrual'
  | 'late'
  | 'stale';

export interface PhaseEstimate {
  date: ISODate;
  phase: CyclePhase;
  /**
   * 1 on the first day of bleeding. While `predicted-menstrual` it counts from
   * the predicted start rather than the logged one, because that day is day 1
   * of the cycle the engine expects to begin there. Absent when there is no
   * logged start yet, and absent while `stale`, where the only number available
   * is days since a start that is no longer the start of anything the engine can
   * describe.
   */
  dayOfCycle?: number;
  /**
   * Days from the predicted start to today, 0 on the predicted day itself.
   * Present only when `phase` is `late`. It counts to today and not to `date`
   * even when the two differ, because being late is a state of the log rather
   * than a property of the day being asked about. `summary` is the other way
   * round: it describes `date`, so its day counts are measured from `date` and
   * can differ from this field on any day that is not today.
   */
  daysLate?: number;
  confidence: number;
  confidenceTier: ConfidenceTier;
  /** Always true. Present so the UI cannot render fertility output without it. */
  fertilityIsEstimateNotContraception: true;
  summary: string;
}

/**
 * The windows of the current cycle.
 *
 * They never overlap. The bleed is indexed forward from the logged start and the
 * fertile window backward from the predicted end, so on a short cycle with a long
 * period the raw ranges collide; `windowsFor` cuts them apart, and drops whatever
 * the state of the log has contradicted, before either this model or
 * `phaseForDate` sees them. These are the only windows there are, so painting
 * these ranges and asking `phaseForDate` day by day give the same answer for
 * every day, in every state of the log.
 */
export interface PhaseModel {
  lutealLength: LearnedLength;
  periodLength: LearnedLength;
  /**
   * Absent until there is a logged start to anchor to, absent while late or
   * stale, and absent whenever `fertileWindow` is, since an ovulation estimate
   * with no window around it is a marker with nowhere to sit.
   */
  estimatedOvulationDate?: ISODate;
  /**
   * Absent while late or stale, and absent in the rare case where the bleed
   * covers every day of it, which is the same days `phaseForDate` calls
   * `menstrual`. Whenever it is absent `phaseForDate` reports no day of this
   * cycle as `fertile`.
   */
  fertileWindow?: DateRange;
  /** Absent while late or stale, and absent if an earlier window covers it. */
  premenstrualWindow?: DateRange;
  /**
   * Anchored to the logged start rather than to the prediction, so it survives
   * both `late` and `stale`. It describes a bleed she logged the start of, which
   * stays true however long the silence after it runs.
   */
  menstrualWindow?: DateRange;
  /**
   * True when the predicted start has passed with nothing logged since. The
   * ovulation estimate and the fertile and premenstrual windows are absent:
   * all three are indexed backward from the end of a cycle whose end is now
   * unknown, so they describe a cycle that is not happening as predicted.
   */
  isLate: boolean;
  /** Days past the predicted start. Present only while `isLate`. */
  daysLate?: number;
  /**
   * True when the log stopped too long ago for these windows to describe a
   * current cycle. Every predicted window is absent in that case, deliberately:
   * a months old fertile window presented as the current one is wrong if she has
   * stopped logging and harmful if the reason is a pregnancy. What is left is
   * `menstrualWindow`, which is a logged fact rather than a prediction.
   */
  isStale: boolean;
  fertilityIsEstimateNotContraception: true;
}

/** One prediction graded against what actually happened. */
export interface CalibrationRecord {
  /** Cycle index of the outcome being graded. */
  cycleIndex: number;
  predictedDate: ISODate;
  actualDate: ISODate;
  /** Actual minus predicted, in days. Positive means she was late. */
  errorDays: number;
  interval50: DateRange;
  interval80: DateRange;
  within50: boolean;
  within80: boolean;
  interval80WidthDays: number;
}

export interface CalibrationSummary {
  records: readonly CalibrationRecord[];
  sampleCount: number;
  /** `NaN` with no records. */
  meanAbsoluteErrorDays: number;
  /** `NaN` with no records. */
  medianAbsoluteErrorDays: number;
  /** Observed fraction of outcomes inside each nominal interval. `NaN` with no records. */
  coverage50: number;
  coverage80: number;
  /** `NaN` with no records. */
  meanInterval80WidthDays: number;
  /** Multiplier the next prediction's intervals get. Always >= 1. */
  widenFactor: number;
  /** Plain sentence describing measured accuracy so far. */
  summary: string;
}

/** A cycle worth mentioning to a clinician, with wording that does not diagnose. */
export interface ClinicalNote {
  cycleIndex: number;
  startDate: ISODate;
  lengthDays: number;
  flag: ClinicalFlag;
  message: string;
}

/** A gap the engine believes is two cycles with a missed start log. */
export interface MissedLogSuspicion {
  cycleIndex: number;
  startDate: ISODate;
  nextStartDate: ISODate;
  gapDays: number;
  /** What a normal cycle looked like at the moment this gap was judged. */
  runningMedianDays: number;
  question: string;
}

/** Everything the engine produces for a given log. */
export interface CycleAnalysis {
  today: ISODate;
  cycles: readonly DerivedCycle[];
  /** Cycles that made it into the fit. */
  usedCycleCount: number;
  posterior: CycleLengthPosterior;
  prediction: NextStartPrediction;
  phases: PhaseModel;
  currentPhase?: PhaseEstimate;
  calibration: CalibrationSummary;
  clinicalNotes: readonly ClinicalNote[];
  missedLogSuspicions: readonly MissedLogSuspicion[];
  confidence: number;
  confidenceTier: ConfidenceTier;
  personalized: boolean;
  /** Sentence describing how much history the prediction rests on. */
  coldStartMessage: string;
}
