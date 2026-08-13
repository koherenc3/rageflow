import { describe, expect, it } from 'vitest';
import {
  FERTILE_DAYS_AFTER_OVULATION,
  FERTILE_DAYS_BEFORE_OVULATION,
  LUTEAL_PRIOR_MEAN_DAYS,
  LUTEAL_PRIOR_SD_DAYS,
  MAX_FITTABLE_PERIOD_LENGTH_DAYS,
  PERIOD_PRIOR_MEAN_DAYS,
  PERIOD_PRIOR_SD_DAYS,
  PREMENSTRUAL_WINDOW_DAYS,
} from '../constants';
import { addDays, diffDays } from '../date';
import { deriveCycles, observedPeriodLengths } from '../cycles';
import {
  buildPhaseModel,
  learnLength,
  learnLutealLength,
  learnPeriodLength,
  phaseForDate,
  type PhaseInputs,
} from '../phases';
import { analyze, logFromStartDates } from '../index';
import { current } from './support';
import type { CycleLog, DayEntry } from '../types';

/**
 * A staleness bound far enough out that these cases never trip it. The late and
 * stale states have their own describe blocks below, where the bound and the day
 * being reported on are both set deliberately.
 */
const NEVER_STALE = '2099-12-31';

function inputsFor(
  starts: readonly string[],
  predictedNextStart: string,
  overrides: Partial<PhaseInputs> = {}
): PhaseInputs {
  const { cycles } = deriveCycles(logFromStartDates(starts));
  return {
    cycles,
    predictedNextStart,
    predictionValidThrough: NEVER_STALE,
    // The day before the prediction, so nothing here is late by default.
    today: addDays(predictedNextStart, -1),
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(),
    confidence: 0.5,
    confidenceTier: 'moderate',
    ...overrides,
  };
}

describe('learnLength', () => {
  it('returns the prior untouched with no observations', () => {
    const learned = learnLength(13, 2, [], 1.5);
    expect(learned).toEqual({ meanDays: 13, sdDays: 2, observationCount: 0, isPrior: true });
  });

  it('moves towards the observations and tightens', () => {
    const learned = learnLength(5, 1.5, [7, 7, 7], 1);
    expect(learned.meanDays).toBeGreaterThan(5);
    expect(learned.meanDays).toBeLessThan(7);
    expect(learned.sdDays).toBeLessThan(1.5);
    expect(learned.isPrior).toBe(false);
    expect(learned.observationCount).toBe(3);
  });

  it('converges on the observed value given enough of them', () => {
    const learned = learnLength(5, 1.5, new Array(200).fill(6), 1);
    expect(learned.meanDays).toBeCloseTo(6, 1);
  });
});

describe('luteal length', () => {
  it('is not hardcoded at 14 days', () => {
    expect(LUTEAL_PRIOR_MEAN_DAYS).not.toBe(14);
  });

  it('sits at its prior when nothing can update it, which is the whole v1 case', () => {
    const learned = learnLutealLength();
    expect(learned.meanDays).toBe(LUTEAL_PRIOR_MEAN_DAYS);
    expect(learned.sdDays).toBe(LUTEAL_PRIOR_SD_DAYS);
    expect(learned.isPrior).toBe(true);
  });

  it('has an update hook ready for a future LH or temperature input', () => {
    const learned = learnLutealLength([11, 11, 11, 11]);
    expect(learned.isPrior).toBe(false);
    expect(learned.meanDays).toBeLessThan(LUTEAL_PRIOR_MEAN_DAYS);
    expect(learned.meanDays).toBeGreaterThan(11);
    expect(learned.sdDays).toBeLessThan(LUTEAL_PRIOR_SD_DAYS);
  });
});

describe('period length', () => {
  it('falls back to the prior when she only logs starts', () => {
    const learned = learnPeriodLength();
    expect(learned.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
    expect(learned.sdDays).toBe(PERIOD_PRIOR_SD_DAYS);
    expect(learned.isPrior).toBe(true);
  });

  it('learns from logged end dates', () => {
    const learned = learnPeriodLength([7, 7, 6]);
    expect(learned.meanDays).toBeGreaterThan(PERIOD_PRIOR_MEAN_DAYS);
    expect(learned.isPrior).toBe(false);
  });

  it('barely moves on one end date, however wrong that one is', () => {
    // The worst a single entry can do, since anything longer is out of the fit
    // entirely. Even then it moves the estimate a fifth of the way, not most of
    // the way, and the result is still a plausible period length.
    const worst = learnPeriodLength([MAX_FITTABLE_PERIOD_LENGTH_DAYS]);
    expect(worst.meanDays - PERIOD_PRIOR_MEAN_DAYS).toBeLessThan(
      (MAX_FITTABLE_PERIOD_LENGTH_DAYS - PERIOD_PRIOR_MEAN_DAYS) / 4
    );
    expect(worst.meanDays).toBeLessThan(8);
  });

  it('still converges on a genuinely longer period given consistent entries', () => {
    // Someone whose period really does run 8 days has to be able to teach the
    // engine that. Damping one entry must not mean ignoring twenty.
    const counts = [1, 4, 8, 16, 32, 64];
    const means = counts.map((count) => learnPeriodLength(new Array(count).fill(8)).meanDays);
    for (let i = 1; i < means.length; i += 1) {
      expect(means[i] as number).toBeGreaterThan(means[i - 1] as number);
      expect(means[i] as number).toBeLessThan(8);
    }
    // A year of consistent entries has clearly moved it off the 5 day prior.
    expect(learnPeriodLength(new Array(12).fill(8)).meanDays).toBeGreaterThan(7);
    expect(learnPeriodLength(new Array(12).fill(7)).meanDays).toBeGreaterThan(6.4);
    // And it does get all the way there in the end.
    expect(learnPeriodLength(new Array(400).fill(8)).meanDays).toBeCloseTo(8, 1);
    expect(learnPeriodLength(new Array(400).fill(7)).meanDays).toBeCloseTo(7, 1);
  });
});

describe('one mistyped end date does not redefine what the app calls a period', () => {
  // She starts on 2024-02-26, means to log the end as 2024-03-01 and types
  // 2024-03-11 instead. Fifteen days is inside the fittable range, so nothing
  // upstream catches it: the only thing standing between that typo and a
  // rewritten phase model is how much weight one observation carries.
  const log: CycleLog = {
    version: 1,
    entries: [
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-29', kind: 'period-start' },
      { date: '2024-02-26', kind: 'period-start' },
      { date: '2024-03-11', kind: 'period-end' },
    ],
  };
  const { cycles } = deriveCycles(log);
  const observed = observedPeriodLengths(cycles);
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: '2024-03-25',
    predictionValidThrough: '2024-04-05',
    today: '2024-03-25',
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observed),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };

  it('takes the typo into the fit rather than silently dropping it', () => {
    // The backstop is not what saves this case, so the case is a real test of
    // the weighting rather than of the bound.
    expect(observed).toEqual([15]);
    expect(cycles[2]?.endDate).toBe('2024-03-11');
  });

  it('leaves the learned period length inside the normal range', () => {
    expect(inputs.periodLength.meanDays).toBeLessThan(8);
  });

  it('still calls the estimated fertile window fertile, not Period.', () => {
    // Without the damping the menstrual window ran to day 12 and swallowed the
    // front of the fertile window, which starts on 2024-03-07.
    for (const date of ['2024-03-07', '2024-03-08', '2024-03-12', '2024-03-13']) {
      const estimate = phaseForDate(inputs, date);
      expect(estimate?.phase).toBe('fertile');
      expect(estimate?.summary).not.toMatch(/Period\./);
    }
  });

  it('keeps the follicular gap between the period and the fertile window', () => {
    expect(phaseForDate(inputs, '2024-03-04')?.phase).toBe('follicular');
    expect(phaseForDate(inputs, '2024-03-06')?.phase).toBe('follicular');
  });
});

describe('a short cycle with a long period, where the windows collide', () => {
  /**
   * The bleed is indexed forward from the start and the fertile window backward
   * from the end, so a short enough cycle with a long enough period puts the
   * same days in both. 22 day cycles with a logged 7 day bleed do it: the cycle
   * end rounds to day 23, ovulation lands on day 11, so the raw fertile window
   * is days 6 to 12 and the bleed is days 1 to 7.
   *
   * Short cycles with long bleeds are a real pattern rather than a case invented
   * to break the model, and the two outputs have to agree about it.
   */
  const CYCLE_DAYS = 22;
  const BLEED_DAYS = 7;
  const entries: DayEntry[] = [];
  for (let i = 0, date = '2024-01-01'; i < 13; i += 1, date = addDays(date, CYCLE_DAYS)) {
    entries.push({ date, kind: 'period-start' });
    entries.push({ date: addDays(date, BLEED_DAYS - 1), kind: 'period-end' });
  }
  const { cycles } = deriveCycles({ version: 1, entries });
  const lastStart = cycles[cycles.length - 1]?.startDate as string;
  const inputs: PhaseInputs = {
    cycles,
    // 22 day cycles fit a mean of 22.69, which rounds to a 23 day cycle.
    predictedNextStart: addDays(lastStart, 23),
    predictionValidThrough: NEVER_STALE,
    today: addDays(lastStart, 3),
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles)),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };
  const model = buildPhaseModel(inputs);

  it('is a history where the raw windows really do collide', () => {
    // Without this the test could pass by describing a cycle with no overlap.
    const ovulation = model.estimatedOvulationDate as string;
    const rawFertileStart = addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION);
    expect(diffDays(rawFertileStart, model.menstrualWindow?.end as string)).toBeGreaterThanOrEqual(
      0
    );
  });

  it('hands back windows that do not overlap', () => {
    expect(
      diffDays(model.menstrualWindow?.end as string, model.fertileWindow?.start as string)
    ).toBe(1);
    expect(
      diffDays(model.fertileWindow?.end as string, model.premenstrualWindow?.start as string)
    ).toBeGreaterThan(0);
  });

  it('gives every day the phase its own model says that day is in', () => {
    // The point of cutting the windows apart in one place. A UI painting the
    // ranges and a UI asking day by day have to agree, and the disagreement this
    // fixes was two days the model called fertile and phaseForDate called period.
    const inWindow = (date: string, range?: { start: string; end: string }) =>
      range !== undefined && diffDays(range.start, date) >= 0 && diffDays(date, range.end) >= 0;
    for (let i = 0; i < 23; i += 1) {
      const date = addDays(lastStart, i);
      const phase = phaseForDate(inputs, date)?.phase;
      expect(phase === 'menstrual', date).toBe(inWindow(date, model.menstrualWindow));
      expect(phase === 'fertile', date).toBe(inWindow(date, model.fertileWindow));
      expect(phase === 'premenstrual', date).toBe(inWindow(date, model.premenstrualWindow));
    }
  });
});

describe('buildPhaseModel', () => {
  const starts = ['2024-01-01', '2024-01-29', '2024-02-26'];
  const predicted = '2024-03-25';
  const model = buildPhaseModel(inputsFor(starts, predicted));

  it('places ovulation a luteal length before the predicted start', () => {
    expect(model.estimatedOvulationDate).toBe(addDays(predicted, -LUTEAL_PRIOR_MEAN_DAYS));
  });

  it('spans the fertile window from five days before to one day after ovulation', () => {
    const ovulation = model.estimatedOvulationDate as string;
    expect(model.fertileWindow?.start).toBe(addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION));
    expect(model.fertileWindow?.end).toBe(addDays(ovulation, FERTILE_DAYS_AFTER_OVULATION));
    expect(
      diffDays(model.fertileWindow?.start as string, model.fertileWindow?.end as string) + 1
    ).toBe(FERTILE_DAYS_BEFORE_OVULATION + FERTILE_DAYS_AFTER_OVULATION + 1);
  });

  it('indexes the premenstrual window backward from the predicted start', () => {
    expect(model.premenstrualWindow?.start).toBe(addDays(predicted, -PREMENSTRUAL_WINDOW_DAYS));
    expect(model.premenstrualWindow?.end).toBe(addDays(predicted, -1));
  });

  it('carries the not-contraception flag', () => {
    expect(model.fertilityIsEstimateNotContraception).toBe(true);
  });

  it('has no windows at all with an empty log', () => {
    const empty = buildPhaseModel(inputsFor([], '2024-03-25'));
    expect(empty.estimatedOvulationDate).toBeUndefined();
    expect(empty.fertileWindow).toBeUndefined();
    expect(empty.isStale).toBe(false);
    expect(empty.fertilityIsEstimateNotContraception).toBe(true);
  });
});

describe('a period that is late', () => {
  // Predicted start 2024-03-25, and the log counts as stale past 2024-04-23.
  const starts = ['2024-01-01', '2024-01-29', '2024-02-26'];
  const validThrough = '2024-04-23';

  function on(today: string): PhaseInputs {
    return inputsFor(starts, '2024-03-25', { predictionValidThrough: validThrough, today });
  }

  it('is not late the day before it is due', () => {
    const inputs = on('2024-03-24');
    expect(phaseForDate(inputs, '2024-03-24')?.phase).toBe('premenstrual');
    expect(buildPhaseModel(inputs).isLate).toBe(false);
  });

  it('reports late from the predicted day itself, counting from zero', () => {
    const estimate = phaseForDate(on('2024-03-25'), '2024-03-25');
    expect(estimate?.phase).toBe('late');
    expect(estimate?.daysLate).toBe(0);
    expect(estimate?.summary).toMatch(/due today/i);
  });

  it('counts the days and keeps the day of cycle honest', () => {
    const estimate = phaseForDate(on('2024-03-31'), '2024-03-31');
    expect(estimate?.phase).toBe('late');
    expect(estimate?.daysLate).toBe(6);
    expect(estimate?.dayOfCycle).toBe(diffDays('2024-02-26', '2024-03-31') + 1);
    expect(estimate?.summary).toMatch(/^6 days past the 2024-03-25 estimate/);
  });

  it('names no cause, because start dates cannot supply one', () => {
    const estimate = phaseForDate(on('2024-04-10'), '2024-04-10');
    expect(estimate?.summary).not.toMatch(/pregnan|might be|could be|may be/i);
  });

  it('drops the fertile window and the ovulation estimate while late', () => {
    // They are indexed backward from a cycle end that has turned out to be
    // wrong, so they describe a cycle that is not happening as predicted.
    const model = buildPhaseModel(on('2024-03-31'));
    expect(model.isLate).toBe(true);
    expect(model.daysLate).toBe(6);
    expect(model.isStale).toBe(false);
    expect(model.fertileWindow).toBeUndefined();
    expect(model.estimatedOvulationDate).toBeUndefined();
    expect(model.premenstrualWindow).toBeUndefined();
    // The bleed is anchored to a start that really happened, so it survives.
    expect(model.menstrualWindow?.start).toBe('2024-02-26');
  });

  it('recovers the moment she logs the start', () => {
    const inputs = inputsFor([...starts, '2024-03-31'], '2024-04-28', {
      predictionValidThrough: '2024-05-26',
      today: '2024-04-02',
    });
    const estimate = phaseForDate(inputs, '2024-04-02');
    expect(estimate?.phase).toBe('menstrual');
    expect(estimate?.daysLate).toBeUndefined();
    expect(estimate?.dayOfCycle).toBe(3);
    expect(buildPhaseModel(inputs).isLate).toBe(false);
    expect(buildPhaseModel(inputs).fertileWindow).toBeDefined();
  });

  it('is a statement about today and not about any date being asked about', () => {
    // The month-calendar case. Today is late, so every day before the predicted
    // start still gets its ordinary phase.
    const inputs = on('2024-03-31');
    expect(phaseForDate(inputs, '2024-03-31')?.phase).toBe('late');
    expect(phaseForDate(inputs, '2024-03-12')?.phase).toBe('fertile');
    expect(phaseForDate(inputs, '2024-02-27')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-01-16')?.phase).toBe('fertile');
  });

  it('stops claiming the predicted bleed once it has not arrived', () => {
    // The engine predicted a period running 2024-03-25 to 2024-03-29 and then
    // watched nothing get logged. Painting those five days on a calendar as a
    // period contradicts the same model's report on today, and it claims a
    // bleed the engine never observed.
    const inputs = on('2024-03-31');
    for (const date of ['2024-03-25', '2024-03-26', '2024-03-29', '2024-03-30']) {
      const estimate = phaseForDate(inputs, date);
      expect(estimate?.phase).toBe('late');
      expect(estimate?.summary).not.toMatch(/Period\./);
      // The count is about today, which is what being late is a property of.
      expect(estimate?.daysLate).toBe(6);
    }
  });

  it('says nothing about a day that has not happened yet', () => {
    // The predicted bleed runs 2024-03-25 to 2024-03-29, so on the first late day
    // most of it is still in the future. Reporting those days would have the
    // engine assert, on the 25th, that nothing was logged by the 27th.
    const inputs = on('2024-03-25');
    expect(phaseForDate(inputs, '2024-03-25')?.phase).toBe('late');
    expect(phaseForDate(inputs, '2024-03-26')).toBeUndefined();
    expect(phaseForDate(inputs, '2024-03-29')).toBeUndefined();
    expect(phaseForDate(inputs, '2024-04-15')).toBeUndefined();
  });

  it('counts the summary from the day it describes rather than from today', () => {
    // Today is 6 days past the estimate, but 2024-03-26 is one day past it, and
    // the sentence is about that day. Three calendar cells each claiming "6 days
    // past" beside three different day numbers is two frames in one line.
    const estimate = phaseForDate(on('2024-03-31'), '2024-03-26');
    expect(estimate?.summary).toMatch(/^1 day past the 2024-03-25 estimate/);
    expect(estimate?.summary).toContain(`Day ${diffDays('2024-02-26', '2024-03-26') + 1} `);
    // The field stays a count to today, because being late is a state of the log.
    expect(estimate?.daysLate).toBe(6);
  });

  it('does not call the predicted day due today once today is past it', () => {
    const estimate = phaseForDate(on('2024-03-31'), '2024-03-25');
    expect(estimate?.summary).not.toMatch(/due today/i);
    expect(estimate?.summary).toMatch(/^Your period was expected on 2024-03-25/);
  });

  it('keeps the due-today wording for today and nothing else', () => {
    // Today is the predicted day, so today is 0 days past the estimate. Two days
    // later, when the same day is 2 days past it, the sentence has to stop
    // reading "due today" on a day that is no longer today.
    expect(phaseForDate(on('2024-03-25'), '2024-03-25')?.summary).toMatch(/due today/i);
    const later = phaseForDate(on('2024-03-27'), '2024-03-25');
    expect(later?.phase).toBe('late');
    expect(later?.summary).not.toMatch(/due today/i);
    expect(later?.summary).toMatch(/^Your period was expected on 2024-03-25/);
    expect(later?.summary).toContain(`Day ${diffDays('2024-02-26', '2024-03-25') + 1},`);
    expect(later?.daysLate).toBe(2);
  });

  it('claims it again the moment the period is only due rather than overdue', () => {
    // The day before the estimate nothing has been contradicted yet, so a
    // forward-looking question about the predicted bleed still gets an answer.
    // It is the predicted bleed rather than a logged one, which is a different
    // claim and says so.
    const inputs = on('2024-03-24');
    expect(phaseForDate(inputs, '2024-03-25')?.phase).toBe('predicted-menstrual');
    expect(phaseForDate(inputs, '2024-03-29')?.phase).toBe('predicted-menstrual');
  });

  it('never calls a completed cycle late', () => {
    const inputs = on('2024-04-10');
    for (const date of ['2024-01-01', '2024-01-16', '2024-01-28', '2024-02-25']) {
      expect(phaseForDate(inputs, date)?.phase).not.toBe('late');
    }
  });
});

describe('a log that has gone stale', () => {
  // Predicted start 2024-03-25, and the log counts as stale past 2024-04-23.
  const starts = ['2024-01-01', '2024-01-29', '2024-02-26'];
  const validThrough = '2024-04-23';

  function on(today: string): PhaseInputs {
    return inputsFor(starts, '2024-03-25', { predictionValidThrough: validThrough, today });
  }

  it('is still only late on the last day the prediction covers', () => {
    const inputs = on(validThrough);
    expect(buildPhaseModel(inputs).isStale).toBe(false);
    expect(phaseForDate(inputs, validThrough)?.phase).toBe('late');
  });

  it('goes stale the day after, rather than reporting a phase it cannot support', () => {
    const inputs = on('2024-04-24');
    expect(phaseForDate(inputs, '2024-04-24')?.phase).toBe('stale');
  });

  it('drops the fertile window and the ovulation estimate entirely', () => {
    // The part that matters most. The likeliest reasons for months of silence
    // are pregnancy, illness, or having stopped using the app, and a months old
    // fertile window is wrong in all three.
    const model = buildPhaseModel(on('2024-08-01'));
    expect(model.isStale).toBe(true);
    expect(model.isLate).toBe(false);
    expect(model.fertileWindow).toBeUndefined();
    expect(model.estimatedOvulationDate).toBeUndefined();
    expect(model.premenstrualWindow).toBeUndefined();
    // The bleed is indexed forward from a start she really logged rather than
    // backward from a predicted end, so it survives here exactly as it does
    // while late, and `phaseForDate` reports those same days as menstrual.
    expect(model.menstrualWindow?.start).toBe('2024-02-26');
    expect(phaseForDate(on('2024-08-01'), '2024-02-27')?.phase).toBe('menstrual');
    // The learned parameters are still facts about her history, so they stay.
    expect(model.periodLength.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
  });

  it('does not claim she is bleeding four months into the silence', () => {
    const estimate = phaseForDate(on('2024-08-01'), '2024-08-01');
    expect(estimate?.phase).toBe('stale');
    expect(estimate?.summary).not.toMatch(/Period\./);
    expect(estimate?.summary).toMatch(/log a period start/i);
  });

  it('reports no day of cycle at all, because there is no cycle to number', () => {
    // Day 158 is not a day of a cycle, and "Day 158." next to a message saying
    // there is nothing current to report is the same false statement in a
    // smaller font.
    const estimate = phaseForDate(on('2024-08-01'), '2024-08-01');
    expect(estimate?.dayOfCycle).toBeUndefined();
    expect(estimate?.summary).not.toMatch(/^Day /);
    expect(estimate?.summary).not.toMatch(/Day \d/);
    // It does say how long the silence has been, named as what it is.
    expect(estimate?.summary).toContain(`${diffDays('2024-02-26', '2024-08-01')} days ago`);
  });

  it('leaves completed cycles alone, however long ago they were', () => {
    // Only the in-progress cycle is anchored to a prediction, so history stays
    // readable no matter how stale the present is.
    const inputs = on('2024-08-01');
    expect(phaseForDate(inputs, '2024-01-16')?.phase).toBe('fertile');
    expect(phaseForDate(inputs, '2024-01-01')?.phase).toBe('menstrual');
  });

  it('stops at today instead of labelling next month stale', () => {
    // The bound the current path already has. A stale model has no credible
    // cycle end, so it has nothing to say about tomorrow, and a consumer drawing
    // next month gets empty cells rather than 31 of them each claiming a state.
    const inputs = on('2024-08-01');
    expect(phaseForDate(inputs, '2024-08-01')?.phase).toBe('stale');
    expect(phaseForDate(inputs, '2024-08-02')).toBeUndefined();
    expect(phaseForDate(inputs, '2024-09-15')).toBeUndefined();
    expect(phaseForDate(inputs, '2026-01-01')).toBeUndefined();
  });

  it('describes the day it was asked about rather than today', () => {
    const estimate = phaseForDate(on('2024-08-01'), '2024-03-12');
    expect(estimate?.phase).toBe('stale');
    expect(estimate?.summary).toContain(
      `${diffDays('2024-02-26', '2024-03-12')} days before this day`
    );
    expect(estimate?.summary).not.toContain('days ago');
  });

  it('keeps the logged bleed but withholds the predicted windows of the stale cycle', () => {
    // Suppressing the fertile window on the model and then handing it back one
    // calendar cell at a time would undo the whole point of suppressing it.
    const inputs = on('2024-08-01');
    expect(phaseForDate(inputs, '2024-02-27')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-03-12')?.phase).toBe('stale');
    expect(phaseForDate(inputs, '2024-03-20')?.phase).toBe('stale');
  });
});

describe('the shape a month calendar gets', () => {
  /**
   * The whole contract in one pass, rather than the two cells that happened to
   * be reported. `late` and `stale` were each extended by exception until they
   * disagreed about what a calendar looks like, and a test that pins only the
   * reported cells leaves the next gap in the contract invisible. Both states
   * are walked the same way here so they cannot drift apart again.
   *
   * The history and the dates are the ones analysis.test.ts already pins: last
   * logged start 2024-05-20, predicted start 2024-06-17, stale past 2024-07-15.
   */
  const starts = [
    '2024-01-01',
    '2024-01-29',
    '2024-02-26',
    '2024-03-25',
    '2024-04-22',
    '2024-05-20',
  ];
  const predictedNextStart = '2024-06-17';
  const validThrough = '2024-07-15';
  const lastStart = '2024-05-20';
  const bleedEnd = addDays(lastStart, PERIOD_PRIOR_MEAN_DAYS - 1);
  const ORDINARY = ['menstrual', 'follicular', 'fertile', 'luteal', 'premenstrual'];

  function walk(from: string, to: string): string[] {
    const dates: string[] = [];
    for (let date = from; diffDays(date, to) >= 0; date = addDays(date, 1)) dates.push(date);
    return dates;
  }

  function on(today: string): PhaseInputs {
    return inputsFor(starts, predictedNextStart, {
      predictionValidThrough: validThrough,
      today,
    });
  }

  it('runs ordinary phases through the predicted bleed while the log is current', () => {
    // The third reach, pinned the same way as the other two. A current log is
    // the only state that answers for a day that has not happened, and the days
    // it answers for are named as predicted rather than as a logged bleed.
    const inputs = on('2024-06-10');
    const predictedBleedEnd = addDays(predictedNextStart, PERIOD_PRIOR_MEAN_DAYS - 1);
    for (const date of walk(lastStart, '2024-08-15')) {
      const estimate = phaseForDate(inputs, date);
      if (diffDays(date, predictedBleedEnd) < 0) {
        expect(estimate, date).toBeUndefined();
      } else if (diffDays(predictedNextStart, date) >= 0) {
        expect(estimate?.phase, date).toBe('predicted-menstrual');
      } else {
        expect(ORDINARY, date).toContain(estimate?.phase);
      }
    }
  });

  it('is contiguous late from the predicted start to today, and blank after it', () => {
    const today = validThrough;
    const inputs = on(today);
    for (const date of walk('2024-05-20', '2024-08-15')) {
      const estimate = phaseForDate(inputs, date);
      if (diffDays(today, date) > 0) {
        expect(estimate, date).toBeUndefined();
      } else if (diffDays(predictedNextStart, date) >= 0) {
        expect(estimate?.phase, date).toBe('late');
      } else {
        expect(ORDINARY, date).toContain(estimate?.phase);
      }
    }
  });

  it('is contiguous stale from the last logged start to today, and blank after it', () => {
    // The one deliberate difference from late: stale covers the days before the
    // predicted start too, because those readings were indexed off a cycle end
    // now known not to have held. The bleed she logged the start of survives,
    // because it is a fact rather than a prediction.
    const today = '2024-10-01';
    const inputs = on(today);
    for (const date of walk('2024-04-22', '2024-11-01')) {
      const estimate = phaseForDate(inputs, date);
      if (diffDays(today, date) > 0) {
        expect(estimate, date).toBeUndefined();
      } else if (diffDays(lastStart, date) < 0) {
        expect(ORDINARY, date).toContain(estimate?.phase);
      } else if (diffDays(bleedEnd, date) <= 0) {
        expect(estimate?.phase, date).toBe('menstrual');
      } else {
        expect(estimate?.phase, date).toBe('stale');
      }
    }
  });
});

describe('phaseForDate', () => {
  // Current cycle starts 2024-02-26, predicted next start 2024-03-25 (28 days).
  // Period 5 days, luteal 13 days, so ovulation is 2024-03-12.
  const inputs = inputsFor(['2024-01-01', '2024-01-29', '2024-02-26'], '2024-03-25');

  const expectations: Array<[string, string]> = [
    ['2024-02-26', 'menstrual'],
    ['2024-03-01', 'menstrual'],
    ['2024-03-02', 'follicular'],
    ['2024-03-06', 'follicular'],
    ['2024-03-07', 'fertile'],
    ['2024-03-12', 'fertile'],
    ['2024-03-13', 'fertile'],
    ['2024-03-14', 'luteal'],
    ['2024-03-19', 'luteal'],
    ['2024-03-20', 'premenstrual'],
    ['2024-03-24', 'premenstrual'],
  ];

  for (const [date, phase] of expectations) {
    it(`calls ${date} ${phase}`, () => {
      expect(phaseForDate(inputs, date)?.phase).toBe(phase);
    });
  }

  it('numbers the day of the cycle from one', () => {
    expect(phaseForDate(inputs, '2024-02-26')?.dayOfCycle).toBe(1);
    expect(phaseForDate(inputs, '2024-03-24')?.dayOfCycle).toBe(28);
  });

  it('claims the predicted bleed for a queried future date, and nothing past it', () => {
    // Today is 2024-03-24 here, so these are forward-looking questions rather
    // than statements about the state of the log. The predicted period runs
    // 2024-03-25 to 2024-03-29 on a 5 day prior.
    expect(phaseForDate(inputs, '2024-03-25')?.phase).toBe('predicted-menstrual');
    expect(phaseForDate(inputs, '2024-03-25')?.dayOfCycle).toBe(1);
    expect(phaseForDate(inputs, '2024-03-29')?.phase).toBe('predicted-menstrual');
    // Past the predicted bleed the engine cannot place a day at all, because
    // the cycle it would be placed in has not started.
    expect(phaseForDate(inputs, '2024-03-30')).toBeUndefined();
    expect(phaseForDate(inputs, '2024-06-01')).toBeUndefined();
  });

  it('never reports a day it only predicts the way it reports one she logged', () => {
    // Same day of the same bleed, once as an estimate and once as a fact. The
    // phase and the sentence both have to tell them apart on their own, because
    // a consumer reading either one alone must not paint a period on a day that
    // has not happened.
    const predicted = phaseForDate(inputs, '2024-03-26');
    expect(predicted?.phase).toBe('predicted-menstrual');
    expect(predicted?.dayOfCycle).toBe(2);
    expect(predicted?.summary).not.toMatch(/Period\./);
    expect(predicted?.summary).toContain('expected to start on 2024-03-25');
    expect(predicted?.summary).toMatch(/estimate/i);

    const logged = phaseForDate(
      inputsFor(['2024-01-01', '2024-01-29', '2024-02-26', '2024-03-25'], '2024-04-22'),
      '2024-03-26'
    );
    expect(logged?.phase).toBe('menstrual');
    expect(logged?.dayOfCycle).toBe(2);
    expect(logged?.summary).toBe('Day 2. Period.');
  });

  it('anchors a historical cycle to what actually happened, not to a prediction', () => {
    // The cycle starting 2024-01-01 really ended on 2024-01-29, so its
    // ovulation sits 13 days before that regardless of the current prediction.
    const estimate = phaseForDate(inputs, '2024-01-16');
    expect(estimate?.phase).toBe('fertile');
    expect(phaseForDate(inputs, '2024-01-19')?.phase).toBe('luteal');
  });

  it('says nothing before the first logged start', () => {
    expect(phaseForDate(inputs, '2023-12-25')).toBeUndefined();
  });

  it('always carries the not-contraception flag and a confidence', () => {
    for (const [date] of expectations) {
      const estimate = phaseForDate(inputs, date);
      expect(estimate?.fertilityIsEstimateNotContraception).toBe(true);
      expect(estimate?.confidence).toBe(0.5);
      expect(estimate?.confidenceTier).toBe('moderate');
    }
  });

  it('spells out that fertility output is an estimate, on the fertile days', () => {
    const estimate = phaseForDate(inputs, '2024-03-12');
    expect(estimate?.summary).toMatch(/not contraception/i);
    expect(estimate?.summary).toMatch(/inferred/i);
  });
});

describe('phases through the public analysis', () => {
  it('reports today, the ovulation estimate, and the fertile window together', () => {
    const analysis = analyze(
      logFromStartDates(['2024-01-01', '2024-01-29', '2024-02-26', '2024-03-25']),
      { today: '2024-04-05' }
    );
    expect(analysis.currentPhase?.date).toBe('2024-04-05');
    expect(analysis.phases.estimatedOvulationDate).toBeDefined();
    expect(analysis.phases.fertileWindow).toBeDefined();
    expect(analysis.phases.lutealLength.isPrior).toBe(true);
    expect(analysis.phases.periodLength.isPrior).toBe(true);
  });

  it('keeps ovulation exactly one luteal length before the predicted start', () => {
    const analysis = analyze(
      logFromStartDates(['2024-01-01', '2024-01-29', '2024-02-26', '2024-03-25']),
      { today: '2024-04-05' }
    );
    expect(
      diffDays(
        analysis.phases.estimatedOvulationDate as string,
        current(analysis.prediction).pointDate
      )
    ).toBe(LUTEAL_PRIOR_MEAN_DAYS);
  });
});
