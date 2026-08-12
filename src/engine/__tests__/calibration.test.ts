import { describe, expect, it } from 'vitest';
import { CALIBRATION_MAX_WIDEN_FACTOR, CALIBRATION_MIN_SAMPLES, INTERVAL_80 } from '../constants';
import { deriveCycles } from '../cycles';
import { diffDays } from '../date';
import {
  buildCalibration,
  emptyCalibration,
  gradePrediction,
  summarizeCalibration,
} from '../calibration';
import { fitCycleLength } from '../cycleLength';
import { nextStartEstimate } from '../prediction';
import { analyze, logFromStartDates } from '../index';
import { current } from './support';
import type { CalibrationRecord } from '../types';

function record(partial: Partial<CalibrationRecord> & { within80: boolean }): CalibrationRecord {
  return {
    cycleIndex: 0,
    predictedDate: '2024-02-01',
    actualDate: '2024-02-01',
    errorDays: 0,
    interval50: { start: '2024-01-30', end: '2024-02-03' },
    interval80: { start: '2024-01-27', end: '2024-02-06' },
    within50: partial.within80,
    interval80WidthDays: 11,
    ...partial,
  };
}

describe('gradePrediction', () => {
  const posterior = fitCycleLength([28, 28, 29, 28]);
  // The raw estimate rather than the presented prediction: calibration grades
  // the numbers the model produced, which is what makes it independent of what
  // a consumer is allowed to see.
  const estimate = nextStartEstimate({
    lastStartDate: '2024-05-01',
    today: '2024-05-01',
    posterior,
    usedCycleCount: 4,
    loggedStartCount: 5,
  });

  it('records the signed error, positive when she was late', () => {
    const late = gradePrediction(0, estimate, '2024-05-31');
    expect(late.errorDays).toBe(diffDays(estimate.pointDate, '2024-05-31'));
    expect(late.errorDays).toBeGreaterThan(0);
    const early = gradePrediction(0, estimate, '2024-05-26');
    expect(early.errorDays).toBeLessThan(0);
  });

  it('records whether the truth landed inside each interval', () => {
    const graded = gradePrediction(0, estimate, estimate.interval80.range.end);
    expect(graded.within80).toBe(true);
    const outside = gradePrediction(0, estimate, '2024-08-01');
    expect(outside.within80).toBe(false);
    expect(outside.within50).toBe(false);
  });

  it('treats the interval ends as inside', () => {
    for (const edge of [estimate.interval50.range.start, estimate.interval50.range.end]) {
      expect(gradePrediction(0, estimate, edge).within50).toBe(true);
    }
  });
});

describe('summarizeCalibration', () => {
  it('reports nothing measurable with no records', () => {
    const summary = emptyCalibration();
    expect(summary.sampleCount).toBe(0);
    expect(summary.meanAbsoluteErrorDays).toBeNaN();
    expect(summary.coverage80).toBeNaN();
    expect(summary.widenFactor).toBe(1);
    expect(summary.summary).toMatch(/not enough history/i);
  });

  it('averages the absolute error and reports the median separately', () => {
    const summary = summarizeCalibration([
      record({ within80: true, errorDays: 1 }),
      record({ within80: true, errorDays: -3 }),
      record({ within80: true, errorDays: 8 }),
    ]);
    expect(summary.meanAbsoluteErrorDays).toBeCloseTo(4, 10);
    expect(summary.medianAbsoluteErrorDays).toBe(3);
  });

  it('leaves intervals alone when coverage is at or above nominal', () => {
    const summary = summarizeCalibration(new Array(10).fill(record({ within80: true })));
    expect(summary.coverage80).toBe(1);
    expect(summary.widenFactor).toBe(1);
  });

  it('holds off widening until it has enough samples to trust', () => {
    const tooFew = summarizeCalibration(
      new Array(CALIBRATION_MIN_SAMPLES - 1).fill(record({ within80: false }))
    );
    expect(tooFew.widenFactor).toBe(1);
  });

  it('widens once coverage runs below nominal', () => {
    const records = [
      ...new Array(4).fill(record({ within80: false })),
      ...new Array(6).fill(record({ within80: true })),
    ];
    const summary = summarizeCalibration(records);
    expect(summary.coverage80).toBeCloseTo(0.6, 10);
    expect(summary.widenFactor).toBeGreaterThan(1);
    expect(summary.summary).toMatch(/widened/i);
  });

  it('widens harder the worse the shortfall is', () => {
    const mild = summarizeCalibration([
      ...new Array(2).fill(record({ within80: false })),
      ...new Array(8).fill(record({ within80: true })),
    ]);
    const severe = summarizeCalibration(new Array(10).fill(record({ within80: false })));
    expect(severe.widenFactor).toBeGreaterThan(mild.widenFactor);
  });

  it('never widens past the cap, however bad it gets', () => {
    const summary = summarizeCalibration(new Array(500).fill(record({ within80: false })));
    expect(summary.widenFactor).toBeLessThanOrEqual(CALIBRATION_MAX_WIDEN_FACTOR);
  });

  it('trusts a small sample less than a large one at the same coverage', () => {
    const small = summarizeCalibration([
      ...new Array(2).fill(record({ within80: false })),
      ...new Array(3).fill(record({ within80: true })),
    ]);
    const large = summarizeCalibration([
      ...new Array(20).fill(record({ within80: false })),
      ...new Array(30).fill(record({ within80: true })),
    ]);
    expect(small.coverage80).toBeCloseTo(large.coverage80, 10);
    expect(large.widenFactor).toBeGreaterThan(small.widenFactor);
  });

  it('states the measured accuracy in plain words', () => {
    const summary = summarizeCalibration([
      record({ within80: true, errorDays: 2 }),
      record({ within80: true, errorDays: -2 }),
    ]);
    expect(summary.summary).toMatch(/2 predictions/);
    expect(summary.summary).toMatch(/average miss was 2\.0 days/);
    expect(summary.summary).toMatch(/100% of the time/);
  });
});

describe('buildCalibration', () => {
  const starts = [
    '2024-01-01',
    '2024-01-29',
    '2024-02-26',
    '2024-03-25',
    '2024-04-22',
    '2024-05-20',
    '2024-06-17',
  ];

  it('grades one prediction per completed cycle', () => {
    const { cycles } = deriveCycles(logFromStartDates(starts));
    const summary = buildCalibration(cycles);
    expect(summary.sampleCount).toBe(starts.length - 1);
  });

  it('uses only the cycles before each outcome, so the numbers are out of sample', () => {
    const { cycles } = deriveCycles(logFromStartDates(starts));
    const summary = buildCalibration(cycles);
    // The first graded prediction has no history at all behind it, so it is the
    // population prior's 29 days rather than the observed 28.
    expect(summary.records[0]?.predictedDate).toBe('2024-01-30');
    expect(summary.records[0]?.errorDays).toBe(-1);
    // Later predictions have learned the real 28 day cycle.
    expect(summary.records[summary.records.length - 1]?.errorDays).toBe(0);
  });

  it('does not charge a missed log against the model', () => {
    const withMissedLog = [
      '2024-01-01',
      '2024-01-29',
      '2024-02-26',
      '2024-03-25',
      '2024-04-22',
      // 2024-05-20 never got logged.
      '2024-06-17',
      '2024-07-15',
    ];
    const { cycles } = deriveCycles(logFromStartDates(withMissedLog));
    const summary = buildCalibration(cycles);
    expect(summary.records.some((r) => Math.abs(r.errorDays) > 20)).toBe(false);
    expect(summary.meanAbsoluteErrorDays).toBeLessThan(2);
  });

  it('feeds the widen factor into the next prediction, not the current one', () => {
    const { cycles } = deriveCycles(logFromStartDates(starts));
    const summary = buildCalibration(cycles);
    // Coverage is perfect on this run, so nothing is widened.
    expect(summary.coverage80).toBe(1);
    const analysis = analyze(logFromStartDates(starts), { today: '2024-06-20' });
    expect(analysis.prediction.appliedWidenFactor).toBe(1);
  });

  it('applies the widen factor to the live prediction when coverage has been poor', () => {
    // Cycle lengths that swing hard enough to fall outside the interval
    // repeatedly. The engine should notice and widen.
    const erratic = [
      '2024-01-01',
      '2024-01-19',
      '2024-03-02',
      '2024-03-20',
      '2024-05-03',
      '2024-05-21',
      '2024-07-04',
      '2024-07-22',
      '2024-09-04',
    ];
    const analysis = analyze(logFromStartDates(erratic), { today: '2024-09-10' });
    expect(analysis.calibration.coverage80).toBeLessThan(INTERVAL_80);
    expect(analysis.calibration.widenFactor).toBeGreaterThan(1);
    expect(analysis.prediction.appliedWidenFactor).toBe(analysis.calibration.widenFactor);

    const unwidened = nextStartEstimate({
      lastStartDate: '2024-09-04',
      today: '2024-09-10',
      posterior: analysis.posterior,
      usedCycleCount: analysis.usedCycleCount,
      loggedStartCount: analysis.cycles.length,
    });
    expect(current(analysis.prediction).interval80.widthDays).toBeGreaterThan(
      unwidened.interval80.widthDays
    );
    expect(current(analysis.prediction).pointDate).toBe(unwidened.pointDate);
  });

  it('is exposed on the analysis so the UI can show measured accuracy', () => {
    const analysis = analyze(logFromStartDates(starts), { today: '2024-06-20' });
    expect(analysis.calibration.summary).toMatch(/average miss/i);
    expect(analysis.calibration.records).toHaveLength(starts.length - 1);
  });
});
