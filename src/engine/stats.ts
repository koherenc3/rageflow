/**
 * The small amount of statistics the engine needs, implemented locally.
 *
 * A general stats library would be a large dependency for four functions, and
 * the Student-t quantile is the one number the whole prediction interval rests
 * on, so it is worth owning and unit-testing against published tables rather
 * than trusting a transitive dependency.
 */

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Natural log of the gamma function. Lanczos approximation, ~15 significant digits. */
export function logGamma(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x <= 0 && Number.isInteger(x)) return Number.POSITIVE_INFINITY;
  if (x < 0.5) {
    // Reflection: gamma(x) * gamma(1-x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = LANCZOS_COEFFICIENTS[0] as number;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    series += (LANCZOS_COEFFICIENTS[i] as number) / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Natural log of the beta function. */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

const CONTINUED_FRACTION_MAX_ITERATIONS = 300;
const CONTINUED_FRACTION_EPSILON = 3e-16;
const TINY = 1e-300;

/** Continued fraction for the incomplete beta, Lentz's method (NR section 6.4). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= CONTINUED_FRACTION_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < CONTINUED_FRACTION_EPSILON) break;
  }
  return h;
}

/** Regularised incomplete beta function `I_x(a, b)`. */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return (
    1 -
    (Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta(b, a)) *
      betaContinuedFraction(b, a, 1 - x)) /
      b
  );
}

/** CDF of the standard Student-t distribution with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError(`Degrees of freedom must be positive: ${df}`);
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

const QUANTILE_TOLERANCE = 1e-10;
const QUANTILE_MAX_ITERATIONS = 200;

/**
 * Inverse CDF of the standard Student-t distribution.
 *
 * Bracket-and-bisect on the CDF. Slower than a closed-form approximation and
 * considerably easier to trust: the CDF is the thing under test, and bisection
 * cannot diverge. We call this a handful of times per prediction, so speed is
 * irrelevant.
 */
export function studentTQuantile(p: number, df: number): number {
  if (!(df > 0)) throw new RangeError(`Degrees of freedom must be positive: ${df}`);
  if (!(p > 0 && p < 1)) {
    if (p === 0) return Number.NEGATIVE_INFINITY;
    if (p === 1) return Number.POSITIVE_INFINITY;
    throw new RangeError(`Probability must be in [0, 1]: ${p}`);
  }
  if (p === 0.5) return 0;

  // Symmetry keeps the search in the upper tail, where the bracket expansion is
  // well behaved even for df below 1.
  if (p < 0.5) return -studentTQuantile(1 - p, df);

  let hi = 1;
  while (studentTCdf(hi, df) < p) {
    hi *= 2;
    if (hi > 1e12) return hi;
  }
  let lo = 0;
  for (let i = 0; i < QUANTILE_MAX_ITERATIONS; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (hi - lo < QUANTILE_TOLERANCE) return mid;
    if (studentTCdf(mid, df) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Standard deviation of a Student-t with `df` degrees of freedom and unit
 * scale. Undefined at or below 2 degrees of freedom; we return `Infinity` there
 * so callers have to think about it rather than silently getting `NaN`.
 */
export function studentTStandardDeviation(df: number): number {
  if (df <= 2) return Number.POSITIVE_INFINITY;
  return Math.sqrt(df / (df - 2));
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
