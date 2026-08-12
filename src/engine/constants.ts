/**
 * Every tunable number in the engine, in one place, each with the reason it has
 * the value it has. Nothing downstream should contain a bare numeric literal
 * that changes behaviour.
 *
 * Sources for the population figures are in docs/RESEARCH.md.
 */

/* ------------------------------------------------------------------ *
 * Layer 1: cycle length
 * ------------------------------------------------------------------ */

/**
 * Normal-Inverse-Gamma prior over cycle length.
 *
 * `mu0 = 29` is the population central cycle length. `kappa0 = 1` says the
 * prior mean is worth about one observed cycle, so a single real cycle already
 * moves it. `alpha0 = 3` with `beta0 = 50` gives a prior mean variance of
 * `beta0 / (alpha0 - 1) = 25`, i.e. a prior standard deviation of 5 days, which
 * matches the population spread of cycle lengths.
 */
export const PRIOR_MU0 = 29;
export const PRIOR_KAPPA0 = 1;
export const PRIOR_ALPHA0 = 3;
export const PRIOR_BETA0 = 50;

/**
 * Recency half life, in cycles.
 *
 * A cycle six cycles back counts half as much as the most recent one. Cycle
 * length genuinely drifts (age, weight, stress, postpartum), so an unweighted
 * mean over all history would lag real change by years. Six cycles is roughly
 * half a year of data, which tracks drift without letting one odd cycle
 * dominate.
 */
export const RECENCY_HALF_LIFE_CYCLES = 6;

/**
 * Cycles below this count as unusually short, above as unusually long. These
 * are the conventional clinical thresholds for cycle length outside the typical
 * range. They are a prompt to mention it to a doctor, never a diagnosis.
 */
export const CLINICAL_SHORT_CYCLE_DAYS = 21;
export const CLINICAL_LONG_CYCLE_DAYS = 45;

/* ------------------------------------------------------------------ *
 * Skip detection
 * ------------------------------------------------------------------ */

/**
 * A gap is treated as two cycles logged as one when it is both a large multiple
 * of the running typical cycle and far out in the predictive tail.
 *
 * The multiple has to clear 1.6x because a genuine long cycle for someone with
 * a 29 day typical length runs to about 45 days (1.55x) and must not be
 * flagged, while a missed log produces something near 2x. The tail test is a
 * second, independent gate: for a woman with genuinely variable cycles the
 * predictive spread is large, so 1.6x alone would flag real cycles. Both
 * conditions must hold. Tuned against the fixtures in
 * src/engine/__tests__/fixtures.test.ts.
 */
export const SKIP_MEDIAN_MULTIPLE = 1.6;
export const SKIP_PREDICTIVE_SD_THRESHOLD = 2.5;

/**
 * Skip detection stays off until this many cycles have been accepted.
 *
 * Without it, someone whose real cycles are long would have her very first
 * cycle flagged against the population prior, which would then keep the prior
 * in place and flag every cycle after it. Two accepted cycles are enough to
 * pull the running estimate towards her actual length.
 */
export const SKIP_MIN_ACCEPTED_CYCLES = 2;

/* ------------------------------------------------------------------ *
 * Layer 2: phases
 * ------------------------------------------------------------------ */

/**
 * Luteal phase prior: 13 days, sd 2.
 *
 * Deliberately a prior over a learned parameter and not the usual hardcoded 14.
 * Luteal length varies between women and between cycles within one woman. With
 * start-date-only logging there is nothing to update it with, so it stays at
 * the prior, and that is the honest answer rather than false precision.
 */
export const LUTEAL_PRIOR_MEAN_DAYS = 13;
export const LUTEAL_PRIOR_SD_DAYS = 2;

/**
 * Assumed measurement noise on a single luteal length observation, used by the
 * update hook that LH or temperature data would eventually feed.
 */
export const LUTEAL_OBSERVATION_SD_DAYS = 1.5;

/** Period (menstrual bleed) length prior: 5 days, sd 1.5. */
export const PERIOD_PRIOR_MEAN_DAYS = 5;
export const PERIOD_PRIOR_SD_DAYS = 1.5;

/** Assumed noise on a single observed period length derived from a logged end date. */
export const PERIOD_OBSERVATION_SD_DAYS = 1;

/**
 * A logged bleed longer than this is not fitted, the same way a gap that looks
 * like two cycles is not fitted.
 *
 * A bleed of more than about two weeks is outside anything the 5 day prior can
 * sensibly absorb, and because the observation noise is only a day, one such
 * value drags the learned period length most of the way to it and turns the
 * first half of the cycle into a reported menstrual window. Fifteen days sits
 * clear of a genuinely long period and well short of a mistyped end date. The
 * entry itself is kept and still shown; only the fit ignores it.
 */
export const MAX_FITTABLE_PERIOD_LENGTH_DAYS = 15;

/**
 * Fertile window relative to estimated ovulation: five days before through one
 * day after. Sperm survive up to about five days in fertile cervical mucus and
 * the egg is viable for roughly a day.
 */
export const FERTILE_DAYS_BEFORE_OVULATION = 5;
export const FERTILE_DAYS_AFTER_OVULATION = 1;

/** The premenstrual phase is the last five days before the predicted start. */
export const PREMENSTRUAL_WINDOW_DAYS = 5;

/* ------------------------------------------------------------------ *
 * Layer 3: calibration
 * ------------------------------------------------------------------ */

/** Nominal coverage of the two intervals the engine reports. */
export const INTERVAL_50 = 0.5;
export const INTERVAL_80 = 0.8;

/** Calibration does nothing until it has seen at least this many real outcomes. */
export const CALIBRATION_MIN_SAMPLES = 4;

/**
 * How hard a coverage shortfall pushes the intervals wider.
 *
 * `widen = 1 + gain * shortfall * n / (n + shrinkage)`. The shrinkage term stops
 * a handful of unlucky cycles from doubling every interval; the cap stops a
 * genuinely unpredictable cycle from producing a useless month-wide range.
 */
export const CALIBRATION_WIDEN_GAIN = 2;
export const CALIBRATION_WIDEN_SHRINKAGE = 4;
export const CALIBRATION_MAX_WIDEN_FACTOR = 2;

/* ------------------------------------------------------------------ *
 * Cold start
 * ------------------------------------------------------------------ */

/** Upper bounds (inclusive) of the cold-start tiers. See docs/PLAN.md. */
export const COLD_START_LOW_MAX_CYCLES = 2;
export const COLD_START_MODERATE_MAX_CYCLES = 5;

/**
 * Confidence shaping.
 *
 * Confidence is the product of two factors, each measured against what this
 * model can actually attain rather than against an ideal it cannot reach. The
 * data factor is the share of the largest effective sample the recency
 * weighting allows, and the precision factor runs from the tightest predictive
 * spread the priors permit up to this ceiling, where it hits zero. Both of
 * those endpoints are derived in cycleLength.ts, so they cannot drift out of
 * step with the priors. A predictive spread of ten days means the engine has
 * nothing useful to say about when the next period is due.
 *
 * The ceiling is 0.95 and not 1 because no amount of history makes a cycle
 * certain. It is reachable: a long, extremely regular history hits it.
 */
export const CONFIDENCE_SD_CEILING_DAYS = 10;
export const CONFIDENCE_MAX = 0.95;
