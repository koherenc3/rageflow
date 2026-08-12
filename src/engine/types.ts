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

/** The prediction for the next period start. */
export interface NextStartPrediction {
  /** Most recent logged start the prediction is anchored to. Absent with an empty log. */
  lastStartDate?: ISODate;
  /** Point estimate. Always presented alongside the intervals, never alone. */
  pointDate: ISODate;
  /** Expected cycle length in days, unrounded. */
  expectedCycleLengthDays: number;
  interval50: CredibleInterval;
  interval80: CredibleInterval;
  /** Multiplier applied to the raw intervals by calibration. 1 when untouched. */
  appliedWidenFactor: number;
  confidence: number;
  confidenceTier: ConfidenceTier;
  /** False until at least one of her own cycles is in the fit. */
  personalized: boolean;
  /** Plain sentence the UI can show verbatim. */
  summary: string;
}

/** A learned scalar with a Gaussian prior. */
export interface LearnedLength {
  meanDays: number;
  sdDays: number;
  /** Observations folded in. Zero means this is still the untouched prior. */
  observationCount: number;
  /** True while no observation has moved it off the prior. */
  isPrior: boolean;
}

export type CyclePhase = 'menstrual' | 'follicular' | 'fertile' | 'luteal' | 'premenstrual';

export interface PhaseEstimate {
  date: ISODate;
  phase: CyclePhase;
  /** 1 on the first day of bleeding. Absent when there is no logged start yet. */
  dayOfCycle?: number;
  confidence: number;
  confidenceTier: ConfidenceTier;
  /** Always true. Present so the UI cannot render fertility output without it. */
  fertilityIsEstimateNotContraception: true;
  summary: string;
}

export interface PhaseModel {
  lutealLength: LearnedLength;
  periodLength: LearnedLength;
  /** Absent until there is a logged start to anchor to. */
  estimatedOvulationDate?: ISODate;
  fertileWindow?: DateRange;
  premenstrualWindow?: DateRange;
  menstrualWindow?: DateRange;
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
  medianAbsoluteErrorDays: number;
  /** Observed fraction of outcomes inside each nominal interval. `NaN` with no records. */
  coverage50: number;
  coverage80: number;
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
