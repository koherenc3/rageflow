import { describe, expect, it } from 'vitest';
import {
  incompleteBeta,
  logBeta,
  logGamma,
  studentTCdf,
  studentTQuantile,
  studentTStandardDeviation,
} from '../stats';

describe('logGamma', () => {
  it('matches known values', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(2)).toBeCloseTo(0, 12);
    expect(logGamma(3)).toBeCloseTo(Math.log(2), 12);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 11);
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
    expect(logGamma(10)).toBeCloseTo(12.801827480081469, 9);
  });

  it('handles the reflection branch', () => {
    // gamma(0.25) * gamma(0.75) = pi / sin(pi/4)
    const sum = logGamma(0.25) + logGamma(0.75);
    expect(sum).toBeCloseTo(Math.log(Math.PI / Math.sin(Math.PI / 4)), 10);
  });
});

describe('logBeta', () => {
  it('matches the closed form for integer arguments', () => {
    // B(2, 3) = 1/12
    expect(logBeta(2, 3)).toBeCloseTo(Math.log(1 / 12), 10);
    // B(1, 1) = 1
    expect(logBeta(1, 1)).toBeCloseTo(0, 12);
  });
});

describe('incompleteBeta', () => {
  it('is pinned at the endpoints', () => {
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
  });

  it('matches the closed form I_x(1, 1) = x', () => {
    for (const x of [0.1, 0.25, 0.5, 0.9]) {
      expect(incompleteBeta(1, 1, x)).toBeCloseTo(x, 12);
    }
  });

  it('satisfies the symmetry I_x(a, b) = 1 - I_(1-x)(b, a)', () => {
    for (const x of [0.05, 0.3, 0.62, 0.97]) {
      expect(incompleteBeta(2.5, 4.5, x)).toBeCloseTo(1 - incompleteBeta(4.5, 2.5, 1 - x), 12);
    }
  });
});

describe('studentTCdf', () => {
  it('is a half at zero for any degrees of freedom', () => {
    for (const df of [0.5, 1, 3, 7.5, 1000]) {
      expect(studentTCdf(0, df)).toBeCloseTo(0.5, 12);
    }
  });

  it('is symmetric', () => {
    for (const df of [1, 4, 12.5]) {
      for (const t of [0.3, 1, 2.7, 6]) {
        expect(studentTCdf(-t, df)).toBeCloseTo(1 - studentTCdf(t, df), 12);
      }
    }
  });

  it('matches the closed form for one degree of freedom', () => {
    // The t distribution with 1 df is standard Cauchy.
    const cauchy = (t: number) => 0.5 + Math.atan(t) / Math.PI;
    for (const t of [-4, -1, 0.5, 2, 9]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(cauchy(t), 10);
    }
  });

  it('matches the closed form for two degrees of freedom', () => {
    const closedForm = (t: number) => 0.5 + t / (2 * Math.sqrt(2 + t * t));
    for (const t of [-3, -0.4, 1.1, 5]) {
      expect(studentTCdf(t, 2)).toBeCloseTo(closedForm(t), 10);
    }
  });

  it('rejects non-positive degrees of freedom', () => {
    expect(() => studentTCdf(1, 0)).toThrow(RangeError);
  });
});

describe('studentTQuantile', () => {
  // Published two-sided critical values, i.e. the 0.975 and 0.95 quantiles.
  const table: Array<{ p: number; df: number; expected: number }> = [
    { p: 0.975, df: 1, expected: 12.7062 },
    { p: 0.975, df: 2, expected: 4.30265 },
    { p: 0.975, df: 3, expected: 3.18245 },
    { p: 0.975, df: 5, expected: 2.57058 },
    { p: 0.975, df: 10, expected: 2.22814 },
    { p: 0.975, df: 20, expected: 2.08596 },
    { p: 0.975, df: 30, expected: 2.04227 },
    { p: 0.975, df: 100, expected: 1.98397 },
    { p: 0.95, df: 1, expected: 6.31375 },
    { p: 0.95, df: 5, expected: 2.01505 },
    { p: 0.95, df: 10, expected: 1.81246 },
    { p: 0.95, df: 30, expected: 1.69726 },
    { p: 0.9, df: 1, expected: 3.07768 },
    { p: 0.9, df: 10, expected: 1.37218 },
    { p: 0.9, df: 30, expected: 1.31042 },
    // The two levels this engine actually reports.
    { p: 0.75, df: 6, expected: 0.717558 },
    { p: 0.9, df: 6, expected: 1.439756 },
  ];

  for (const { p, df, expected } of table) {
    it(`q(${p}, df=${df}) = ${expected}`, () => {
      expect(studentTQuantile(p, df)).toBeCloseTo(expected, 4);
    });
  }

  it('is exactly 1 at the upper quartile of the Cauchy', () => {
    expect(studentTQuantile(0.75, 1)).toBeCloseTo(1, 8);
  });

  it('approaches the normal quantile as degrees of freedom grow', () => {
    expect(studentTQuantile(0.975, 1e7)).toBeCloseTo(1.959964, 4);
    expect(studentTQuantile(0.9, 1e7)).toBeCloseTo(1.281552, 4);
  });

  it('is the inverse of the CDF', () => {
    for (const df of [1.5, 4, 9, 50]) {
      for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
        expect(studentTCdf(studentTQuantile(p, df), df)).toBeCloseTo(p, 8);
      }
    }
  });

  it('is symmetric about zero', () => {
    for (const df of [2, 8, 25]) {
      for (const p of [0.05, 0.2, 0.35]) {
        expect(studentTQuantile(p, df)).toBeCloseTo(-studentTQuantile(1 - p, df), 8);
      }
    }
  });

  it('is monotone in p', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let p = 0.01; p < 0.995; p += 0.01) {
      const value = studentTQuantile(p, 7);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('rejects impossible arguments', () => {
    expect(() => studentTQuantile(1.2, 5)).toThrow(RangeError);
    expect(() => studentTQuantile(-0.1, 5)).toThrow(RangeError);
    expect(() => studentTQuantile(0.5, -1)).toThrow(RangeError);
  });

  it('throws rather than returning the bound when the bracket overruns', () => {
    // Fractional degrees of freedom put so much mass in the tail that the
    // search never brackets the quantile. Handing back the bound would look
    // like an answer and turn into a date three billion years out.
    expect(() => studentTQuantile(0.99, 0.1)).toThrow(RangeError);
    expect(() => studentTQuantile(0.95, 0.05)).toThrow(RangeError);
  });
});

describe('studentTStandardDeviation', () => {
  it('is undefined at or below two degrees of freedom', () => {
    expect(studentTStandardDeviation(2)).toBe(Number.POSITIVE_INFINITY);
    expect(studentTStandardDeviation(1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('shrinks towards one as degrees of freedom grow', () => {
    expect(studentTStandardDeviation(6)).toBeCloseTo(Math.sqrt(1.5), 12);
    expect(studentTStandardDeviation(1e6)).toBeCloseTo(1, 5);
  });
});
