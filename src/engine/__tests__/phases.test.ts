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
import { AFTER_EVERY_START, current } from './support';
import type { CycleLog, DayEntry } from '../types';

/**
 * A staleness bound far enough out that these cases never trip it. The late and
 * stale states have their own describe blocks below, where the bound and the day
 * being reported on are both set deliberately.
 */
const NEVER_STALE = '2099-12-31';

/** Every calendar date from `from` to `to`, both ends included. */
function walkDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; diffDays(date, to) >= 0; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function inputsFor(
  starts: readonly string[],
  predictedNextStart: string,
  overrides: Partial<PhaseInputs> = {}
): PhaseInputs {
  const { cycles } = deriveCycles(logFromStartDates(starts), AFTER_EVERY_START);
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
  // upstream catches it: the only thing standing between that typo and every
  // other cycle in the log is how much weight one observation carries.
  //
  // The cycle she typed it on is a different question. That one is hers, and it
  // is shown as she recorded it.
  const log: CycleLog = {
    version: 1,
    entries: [
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-29', kind: 'period-start' },
      { date: '2024-02-26', kind: 'period-start' },
      { date: '2024-03-11', kind: 'period-end' },
    ],
  };
  const { cycles } = deriveCycles(log, AFTER_EVERY_START);
  const observed = observedPeriodLengths(cycles, '2024-03-13');
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: '2024-03-25',
    predictionValidThrough: '2024-04-05',
    // Mid-cycle, so the log is current and the fertile window is on the model.
    // What is under test is the learned period length, not the state of the log.
    today: '2024-03-13',
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

  it('leaves the cycles she logged no end for to the learned length', () => {
    // The cycle starting 2024-01-01 has no end date of its own, so the damped
    // 7 day estimate is what describes it. Undamped, one 15 day entry pulled
    // that estimate to 11.9, which rounded to a 12 day window and reported
    // "Period." across the front of this cycle's own fertile window.
    expect(phaseForDate(inputs, '2024-01-07')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-01-08')?.phase).toBe('follicular');
    for (const date of ['2024-01-11', '2024-01-16', '2024-01-17']) {
      const estimate = phaseForDate(inputs, date);
      expect(estimate?.phase, date).toBe('fertile');
      expect(estimate?.summary, date).not.toMatch(/Period\./);
    }
  });

  it('shows the cycle she typed it on exactly as she typed it', () => {
    // Her own entry governs her own cycle. The engine holds a recorded end date
    // for this bleed, so reporting the learned estimate over the top of it would
    // be an estimate contradicting a fact.
    for (const date of ['2024-03-01', '2024-03-07', '2024-03-11']) {
      expect(phaseForDate(inputs, date)?.phase, date).toBe('menstrual');
    }
    // Only the days past the end she logged are anything else, and what is left
    // of the fertile window after the cut is still fertile.
    expect(phaseForDate(inputs, '2024-03-12')?.phase).toBe('fertile');
    expect(buildPhaseModel(inputs).menstrualWindow?.end).toBe('2024-03-11');
  });
});

describe('the end date she logged governs the bleed of the cycle she logged it on', () => {
  // The learned length predicts the cycles she has not described. On one she
  // has, it is not consulted at all: the engine holds the fact and must not
  // report an estimate on top of it.
  const log: CycleLog = {
    version: 1,
    entries: [
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-02', kind: 'period-end' },
      { date: '2024-01-29', kind: 'period-start' },
      { date: '2024-02-26', kind: 'period-start' },
    ],
  };
  const { cycles } = deriveCycles(log, AFTER_EVERY_START);
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: '2024-03-25',
    predictionValidThrough: '2024-04-23',
    today: '2024-03-13',
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles, '2024-03-13')),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };

  it('is a case where the estimate and the logged end really do differ', () => {
    // Without this the test could pass by describing a cycle whose logged end
    // happens to land exactly where the learned length already put it.
    expect(cycles[0]?.endDate).toBe('2024-01-02');
    expect(Math.round(inputs.periodLength.meanDays)).toBe(4);
  });

  it('ends the bleed where she said it ended, not where the estimate did', () => {
    expect(phaseForDate(inputs, '2024-01-02')?.phase).toBe('menstrual');
    // 2024-01-03 and 2024-01-04 are inside the 4 day estimate and outside what
    // she recorded. She wrote down that she had stopped bleeding.
    expect(phaseForDate(inputs, '2024-01-03')?.phase).toBe('follicular');
    expect(phaseForDate(inputs, '2024-01-04')?.phase).toBe('follicular');
    expect(phaseForDate(inputs, '2024-01-03')?.summary).not.toMatch(/Period\./);
  });

  it('still uses the learned length for the cycles she logged no end for', () => {
    // The estimate is not being taken away, it is being kept to the job it is
    // for. The cycle starting 2024-01-29 has no end date, so its bleed is the
    // learned 4 days.
    expect(phaseForDate(inputs, '2024-02-01')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-02-02')?.phase).toBe('follicular');
    expect(buildPhaseModel(inputs).menstrualWindow).toEqual({
      start: '2024-02-26',
      end: addDays('2024-02-26', 3),
    });
  });
});

describe('an implausibly long logged end is shown rather than clamped', () => {
  // She means 2024-02-28 and types 2024-03-18, which is 22 days.
  // `MAX_FITTABLE_PERIOD_LENGTH_DAYS` keeps that out of the fit and deliberately
  // does not clamp what is shown: the entry is health data she typed in, the app
  // does not get to overwrite it, and clamping the drawn window is that same
  // overwriting moved to the display layer. A 22 day band on screen is itself
  // the signal that the entry is wrong.
  const log: CycleLog = {
    version: 1,
    entries: [
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-29', kind: 'period-start' },
      { date: '2024-02-26', kind: 'period-start' },
      { date: '2024-03-18', kind: 'period-end' },
    ],
  };
  const { cycles } = deriveCycles(log, AFTER_EVERY_START);
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: '2024-03-25',
    predictionValidThrough: '2024-04-23',
    today: '2024-03-20',
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles, '2024-03-20')),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };
  const model = buildPhaseModel(inputs);

  it('keeps it out of the fit, so no other cycle is touched by it', () => {
    expect(observedPeriodLengths(cycles, '2024-03-20')).toEqual([]);
    expect(model.periodLength.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
    expect(cycles[2]?.periodLengthDays).toBe(22);
  });

  it('draws the window at the full logged length, past the fittable bound', () => {
    const window = model.menstrualWindow;
    expect(window?.end).toBe('2024-03-18');
    expect(diffDays(window?.start as string, window?.end as string) + 1).toBe(22);
    expect(diffDays(window?.start as string, window?.end as string) + 1).toBeGreaterThan(
      MAX_FITTABLE_PERIOD_LENGTH_DAYS
    );
  });

  it('lets it swallow the fertile window rather than trimming the entry', () => {
    // The failure direction is safe: a mistyped end suppresses fertility output
    // rather than over-claiming it.
    expect(model.fertileWindow).toBeUndefined();
    expect(model.estimatedOvulationDate).toBeUndefined();
    expect(phaseForDate(inputs, '2024-03-12')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-03-19')?.phase).toBe('luteal');
  });
});

describe('an end date logged for days that have not happened', () => {
  // She means 2024-03-02 and types 2024-03-20, ten days after today. Nothing
  // upstream stops that: an end date is only checked for being a calendar date
  // that belongs to this cycle, and the two rules that keep every other output
  // inside today are read off the state of the log, which the bleed is decided
  // ahead of.
  const starts = ['2024-01-01', '2024-01-29', '2024-02-26'];
  const entries: DayEntry[] = [
    ...starts.map((date): DayEntry => ({ date, kind: 'period-start' })),
    { date: '2024-03-20', kind: 'period-end' },
  ];
  const { cycles } = deriveCycles({ version: 1, entries }, AFTER_EVERY_START);

  // The last day of her entry the engine will carry forward past today: the
  // longest bleed the fit will accept, counted from the start she logged.
  // Projecting her entry further is a claim about the future rather than a
  // record of anything, and it gets the bound every other projection gets.
  const PROJECTED_THROUGH = addDays('2024-02-26', MAX_FITTABLE_PERIOD_LENGTH_DAYS - 1);

  function on(today: string): PhaseInputs {
    return {
      cycles,
      predictedNextStart: '2024-03-25',
      predictionValidThrough: '2024-04-23',
      today,
      lutealLength: learnLutealLength(),
      periodLength: learnPeriodLength(observedPeriodLengths(cycles, today)),
      confidence: 0.5,
      confidenceTier: 'moderate',
    };
  }

  it('keeps her entry exactly as she typed it', () => {
    // The bound is on what the engine asserts, not on what it stores.
    expect(cycles[2]?.endDate).toBe('2024-03-20');
    expect(cycles[2]?.periodLengthDays).toBe(24);
  });

  it('draws the bleed to today and stops', () => {
    const inputs = on('2024-03-10');
    expect(buildPhaseModel(inputs).menstrualWindow).toEqual({
      start: '2024-02-26',
      end: '2024-03-10',
    });
    expect(phaseForDate(inputs, '2024-03-10')?.phase).toBe('menstrual');
  });

  it('says she is bleeding on no day that has not arrived', () => {
    // Walked rather than sampled, and named as the phase each day does get, so
    // the loop cannot pass by those days coming back with no phase at all. No
    // day past today is a period she recorded, on the strength of her entry or
    // of anything else. The days of it the engine still carries forward are
    // bleed days it expects rather than ones it has been told about: not
    // `menstrual`, which would be a fact about a day that has not happened, and
    // not the follicular or luteal half either, which would contradict an entry
    // she typed in herself. Past the projection her entry stops holding days
    // back, and they take their ordinary phase exactly as the days past it do.
    const today = '2024-03-10';
    const inputs = on(today);
    let projected = 0;
    let pastTheProjection = 0;
    for (const date of walkDates('2024-02-26', '2024-03-24')) {
      const estimate = phaseForDate(inputs, date);
      if (diffDays(today, date) <= 0) continue;
      expect(estimate?.summary, date).not.toMatch(/Period\./);
      if (diffDays(date, PROJECTED_THROUGH) >= 0) {
        projected += 1;
        expect(estimate?.phase, date).toBe('predicted-menstrual');
        expect(estimate?.predictedBleedBasis, date).toBe('continues-logged-bleed');
      } else {
        pastTheProjection += 1;
        expect(['follicular', 'fertile', 'luteal', 'premenstrual'], date).toContain(
          estimate?.phase
        );
      }
    }
    // Not vacuous in either direction: a day of her entry past today is carried
    // forward here, and thirteen days past the projection are walked as well.
    expect(projected).toBe(1);
    expect(pastTheProjection).toBe(13);
  });

  it('words the days it does carry forward as her entry rather than as a guess', () => {
    // The provenance a consumer can read off the sentence, and the field that
    // means it does not have to. This day belongs to a period whose start she
    // typed in, so the sentence names that start, and it still says the day has
    // not arrived, because an entry about a day that has not happened is not a
    // record of it.
    const estimate = phaseForDate(on('2024-03-10'), PROJECTED_THROUGH);
    expect(estimate?.phase).toBe('predicted-menstrual');
    expect(estimate?.predictedBleedBasis).toBe('continues-logged-bleed');
    expect(estimate?.dayOfCycle).toBe(diffDays('2024-02-26', PROJECTED_THROUGH) + 1);
    expect(estimate?.summary).toBe(
      `Day ${diffDays('2024-02-26', PROJECTED_THROUGH) + 1} of the period you logged starting on 2024-02-26. This day has not arrived yet, so it is still expected rather than a day you have recorded bleeding on.`
    );
  });

  it('carries it no further forward than a period could plausibly run', () => {
    // The bound on the projection, in the direction it matters: the day after
    // the longest bleed the fit would accept is not claimed as her bleed, and
    // the reach does not grow with the size of the typo. She typed nine more
    // days than this after it.
    const inputs = on('2024-03-10');
    const last = phaseForDate(inputs, PROJECTED_THROUGH);
    const past = phaseForDate(inputs, addDays(PROJECTED_THROUGH, 1));
    expect(last?.predictedBleedBasis).toBe('continues-logged-bleed');
    expect(past?.phase).not.toBe('predicted-menstrual');
    expect(diffDays(PROJECTED_THROUGH, '2024-03-20')).toBe(9);
  });

  it('reads differently from the bleed the engine expects next', () => {
    // Same phase, different provenance, and a consumer must be able to tell
    // them apart without matching on a sentence. The predicted next bleed is
    // counted from a start nothing has been logged for; this one is counted
    // from a start she typed in.
    const inputs = on('2024-03-10');
    const continues = phaseForDate(inputs, PROJECTED_THROUGH);
    const expected = phaseForDate(inputs, '2024-03-26');
    expect(continues?.phase).toBe('predicted-menstrual');
    expect(continues?.predictedBleedBasis).toBe('continues-logged-bleed');
    expect(expected?.phase).toBe('predicted-menstrual');
    expect(expected?.predictedBleedBasis).toBe('expected-next-bleed');
    expect(expected?.summary).toContain('expected to start on 2024-03-25');
    expect(expected?.summary).not.toBe(continues?.summary);
    expect(expected?.dayOfCycle).toBe(2);
  });

  it('publishes no fertility estimate for this cycle at all', () => {
    // Her entry records 24 days of bleeding, longer than any period the fit will
    // accept, so the engine cannot say when this cycle's bleed ended. The
    // ovulation estimate is read off the structure of the cycle and off nothing
    // else, so a cycle whose structure cannot be read does not get one. That
    // holds on both sides of the day her entry names: the calendar catching up
    // with an entry cannot turn a cycle the engine could not read into one it
    // can, and a fertility estimate that appears for ten days and then vanishes
    // is the estimate contradicting itself rather than the engine correcting.
    for (const today of ['2024-03-10', '2024-03-20']) {
      const model = buildPhaseModel(on(today));
      expect(model.fertileWindow, today).toBeUndefined();
      expect(model.estimatedOvulationDate, today).toBeUndefined();
      for (const date of walkDates('2024-02-26', '2024-03-24')) {
        expect(phaseForDate(on(today), date)?.phase, `${today} ${date}`).not.toBe('fertile');
      }
    }
  });

  it('is past the bleed the fit will accept, which is what withholds it', () => {
    // Naming the trigger, so this block cannot be read as fertility being
    // withheld for having an end date at all. A cycle whose recorded bleed sits
    // inside the bound keeps its estimate: same start, same predicted end, an
    // end date one day shorter than the bound.
    const inside: DayEntry[] = [
      ...starts.map((date): DayEntry => ({ date, kind: 'period-start' })),
      { date: addDays('2024-02-26', MAX_FITTABLE_PERIOD_LENGTH_DAYS - 2), kind: 'period-end' },
    ];
    const derived = deriveCycles({ version: 1, entries: inside }, AFTER_EVERY_START);
    expect(derived.cycles[2]?.periodLengthDays).toBe(MAX_FITTABLE_PERIOD_LENGTH_DAYS - 1);
    expect(cycles[2]?.periodLengthDays as number).toBeGreaterThan(MAX_FITTABLE_PERIOD_LENGTH_DAYS);
    const model = buildPhaseModel({ ...on('2024-03-10'), cycles: derived.cycles });
    expect(model.estimatedOvulationDate).toBe(addDays('2024-03-25', -LUTEAL_PRIOR_MEAN_DAYS));
    expect(model.fertileWindow).toBeDefined();
  });

  it('is a case where there really would have been a window to publish', () => {
    // Without this the test above could pass on a cycle that has no fertile
    // window for reasons of its own. The raw window, before anything is cut
    // away from it, sits inside the span she typed.
    const ovulation = addDays('2024-03-25', -LUTEAL_PRIOR_MEAN_DAYS);
    const rawStart = addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION);
    const rawEnd = addDays(ovulation, FERTILE_DAYS_AFTER_OVULATION);
    expect(diffDays('2024-02-26', rawStart)).toBeGreaterThan(0);
    expect(diffDays(rawEnd, '2024-03-20')).toBeGreaterThan(0);
  });

  it('says nothing about her entry in the sentences those days do get', () => {
    // The days past the projection take their ordinary phase, which says where
    // they sit relative to the ovulation estimate and nothing more. The sentence
    // has to stop there too: "after the period" asserts that the period is over,
    // which is a claim about her body rather than about the layout, and her
    // entry names every one of these days as part of the bleed. Naming the
    // period the engine expects next is a different sentence and is left alone.
    const inputs = on('2024-03-10');
    let walked = 0;
    for (const date of walkDates(addDays(PROJECTED_THROUGH, 1), '2024-03-20')) {
      walked += 1;
      expect(phaseForDate(inputs, date)?.summary, date).not.toMatch(
        /(after|since|between|end of) the period/i
      );
    }
    expect(walked).toBe(9);
    expect(phaseForDate(inputs, '2024-03-12')?.phase).toBe('follicular');
    expect(phaseForDate(inputs, '2024-03-12')?.summary).toBe(
      'Day 16. Follicular phase, the first half of the cycle.'
    );
  });

  it('keeps the run-up, laid out after the bleed', () => {
    // The other window indexed backward from the cycle end. It is not a
    // fertility estimate, so the rule above does not reach it, and dropping it
    // would put a hole in a month calendar for no reason the engine can state.
    // With no fertile window to cut against it is cut against the same span the
    // bleed occupies: its natural place while the entry is carried only as far
    // as the projection, and the day after the entry once the whole of it has
    // arrived.
    expect(buildPhaseModel(on('2024-03-10')).premenstrualWindow?.start).toBe(
      addDays('2024-03-25', -PREMENSTRUAL_WINDOW_DAYS)
    );
    expect(buildPhaseModel(on('2024-03-20')).premenstrualWindow?.start).toBe('2024-03-21');
  });

  it('reports the whole entry once the days it names have passed', () => {
    // The other side of the rule, which is the round 11 decision unchanged: a
    // 24 day bleed that has actually happened is shown at its full length, and
    // it is still allowed to swallow the fertile window of the cycle it is on.
    const inputs = on('2024-03-20');
    const model = buildPhaseModel(inputs);
    expect(model.menstrualWindow?.end).toBe('2024-03-20');
    expect(model.fertileWindow).toBeUndefined();
    expect(phaseForDate(inputs, '2024-03-15')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-03-15')?.summary).toBe(
      `Day ${diffDays('2024-02-26', '2024-03-15') + 1}. Period.`
    );
  });
});

describe('an end date mistyped into next year', () => {
  // The far end of the same rule. She means 2024-01-31 and types 2024-12-31, so
  // her entry names eleven months of days that have not happened. What the
  // engine may say about them cannot scale with the size of her typo: a bound
  // that is the length of whatever she typed is not a bound.
  const starts = ['2024-01-01', '2024-01-29'];
  const entries: DayEntry[] = [
    ...starts.map((date): DayEntry => ({ date, kind: 'period-start' })),
    { date: '2024-12-31', kind: 'period-end' },
  ];
  const { cycles } = deriveCycles({ version: 1, entries }, AFTER_EVERY_START);
  const TODAY = '2024-02-10';
  const PREDICTED_NEXT_START = '2024-02-26';
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: PREDICTED_NEXT_START,
    predictionValidThrough: '2024-03-25',
    today: TODAY,
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles, TODAY)),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };

  it('keeps the entry, and keeps it out of the fit', () => {
    expect(cycles[1]?.endDate).toBe('2024-12-31');
    expect(observedPeriodLengths(cycles, TODAY)).toEqual([]);
    expect(inputs.periodLength.meanDays).toBe(PERIOD_PRIOR_MEAN_DAYS);
  });

  it('carries it forward no further than a period can plausibly run', () => {
    const projectedThrough = addDays('2024-01-29', MAX_FITTABLE_PERIOD_LENGTH_DAYS - 1);
    expect(phaseForDate(inputs, projectedThrough)?.predictedBleedBasis).toBe(
      'continues-logged-bleed'
    );
    expect(phaseForDate(inputs, addDays(projectedThrough, 1))?.phase).not.toBe(
      'predicted-menstrual'
    );
  });

  it('still stops where the log lets it stop, rather than eleven months out', () => {
    // The reach of a current log is the last day of the bleed it expects next,
    // and one mistyped digit must not extend it. Sampled across the months her
    // entry names, all of which are past that bound.
    const lastDayItCanDescribe = addDays(PREDICTED_NEXT_START, PERIOD_PRIOR_MEAN_DAYS - 1);
    expect(phaseForDate(inputs, lastDayItCanDescribe)?.phase).toBe('predicted-menstrual');
    for (const date of ['2024-03-02', '2024-06-01', '2024-12-31']) {
      expect(phaseForDate(inputs, date), date).toBeUndefined();
    }
  });

  it('publishes no fertility estimate for the cycle carrying the typo', () => {
    // The entry says this bleed is still running eleven months out, so the
    // engine has no reading of when it ended and no cycle structure to time an
    // ovulation against. It withholds the estimate rather than placing one in
    // the gap its own bound opens up, which is the answer it already gives
    // whenever it stops trusting its inputs.
    const model = buildPhaseModel(inputs);
    const ovulation = addDays(PREDICTED_NEXT_START, -LUTEAL_PRIOR_MEAN_DAYS);
    expect(model.fertileWindow).toBeUndefined();
    expect(model.estimatedOvulationDate).toBeUndefined();
    expect(phaseForDate(inputs, ovulation)?.phase).not.toBe('fertile');
    for (const date of walkDates('2024-01-29', addDays(PREDICTED_NEXT_START, -1))) {
      expect(phaseForDate(inputs, date)?.phase, date).not.toBe('fertile');
    }
  });

  it('holds nothing else back for as long as the typo runs', () => {
    // The containment, which is the reason the suppression above is affordable:
    // it is one cycle's estimate, not eleven months of blanked output. The
    // run-up still sits where the predicted start puts it, the days past the
    // projection take their ordinary phase, and the next start she logs starts a
    // cycle the engine can read again.
    const model = buildPhaseModel(inputs);
    expect(model.premenstrualWindow?.end).toBe(addDays(PREDICTED_NEXT_START, -1));
    expect(model.premenstrualWindow?.start).toBe(
      addDays(PREDICTED_NEXT_START, -PREMENSTRUAL_WINDOW_DAYS)
    );
    expect(phaseForDate(inputs, '2024-02-20')?.phase).toBe('luteal');
  });
});

describe('a logged bleed carried forward towards a start the engine expects', () => {
  // The other half of the bound, on a deliberately artificial history: 12 day
  // cycles, well below anything clinical, because a real cycle is longer than
  // the plausible bleed bound and so that bound always bites first. Here it does
  // not, and the projection has to stop at the predicted start anyway, because
  // the days from there belong to the cycle the engine expects next and a bleed
  // it has been told nothing about is a bleed of that one.
  const starts = ['2024-01-01', '2024-01-13'];
  const entries: DayEntry[] = [
    ...starts.map((date): DayEntry => ({ date, kind: 'period-start' })),
    { date: '2024-01-30', kind: 'period-end' },
  ];
  const { cycles } = deriveCycles({ version: 1, entries }, AFTER_EVERY_START);
  const PREDICTED_NEXT_START = '2024-01-25';
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: PREDICTED_NEXT_START,
    predictionValidThrough: '2024-02-20',
    today: '2024-01-14',
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };

  it('is a case where the plausible bleed bound would have reached further', () => {
    expect(diffDays('2024-01-13', PREDICTED_NEXT_START)).toBeLessThan(
      MAX_FITTABLE_PERIOD_LENGTH_DAYS - 1
    );
  });

  it('carries it to the day before that start and no further', () => {
    const lastProjected = phaseForDate(inputs, addDays(PREDICTED_NEXT_START, -1));
    const first = phaseForDate(inputs, PREDICTED_NEXT_START);
    expect(lastProjected?.predictedBleedBasis).toBe('continues-logged-bleed');
    expect(first?.predictedBleedBasis).toBe('expected-next-bleed');
    expect(first?.dayOfCycle).toBe(1);
  });
});

describe('a cycle she has logged no end for', () => {
  // The learned length describes the cycles she has not described herself, so
  // it is what says how long this bleed runs. It is an estimate rather than an
  // entry, which is if anything less of a licence to report a day that has not
  // happened as one she bled through: the engine holds no record of that day at
  // all. Her last logged start is 2024-02-10 and there is nothing after it.
  //
  // 20 day cycles, so the estimated bleed and the fertile window are close
  // enough together for the layout to be visible: the bleed runs 2024-02-10 to
  // 2024-02-14 and the raw fertile window 2024-02-12 to 2024-02-18, so five of
  // those days are contested and which end the cut is taken against decides
  // where the published window starts.
  const starts = ['2024-01-01', '2024-01-21', '2024-02-10'];
  const { cycles } = deriveCycles(logFromStartDates(starts), AFTER_EVERY_START);
  const PREDICTED_NEXT_START = '2024-03-01';
  const ESTIMATED_BLEED_END = addDays('2024-02-10', PERIOD_PRIOR_MEAN_DAYS - 1);

  function on(today: string): PhaseInputs {
    return {
      cycles,
      predictedNextStart: PREDICTED_NEXT_START,
      predictionValidThrough: '2024-03-20',
      today,
      lutealLength: learnLutealLength(),
      periodLength: learnPeriodLength(observedPeriodLengths(cycles, today)),
      confidence: 0.5,
      confidenceTier: 'moderate',
    };
  }

  it('is a case where the estimated bleed runs past today and into the raw window', () => {
    // Without this the days walked below would be outside the estimate anyway,
    // and the layout case further down would have nothing to contest. The
    // learned length is the untouched prior, so the estimated bleed is days 1
    // to 5, and the raw fertile window opens on day 3 of it.
    expect(on('2024-02-11').periodLength.isPrior).toBe(true);
    expect(ESTIMATED_BLEED_END).toBe('2024-02-14');
    const ovulation = addDays(PREDICTED_NEXT_START, -LUTEAL_PRIOR_MEAN_DAYS);
    const rawFertileStart = addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION);
    expect(diffDays(rawFertileStart, ESTIMATED_BLEED_END)).toBeGreaterThan(0);
  });

  it('claims only the days of the estimated bleed that have happened', () => {
    const inputs = on('2024-02-11');
    expect(buildPhaseModel(inputs).menstrualWindow).toEqual({
      start: '2024-02-10',
      end: '2024-02-11',
    });
    expect(phaseForDate(inputs, '2024-02-11')?.phase).toBe('menstrual');
    for (const date of walkDates('2024-02-12', ESTIMATED_BLEED_END)) {
      const estimate = phaseForDate(inputs, date);
      expect(estimate?.phase, date).toBe('predicted-menstrual');
      expect(estimate?.summary, date).not.toMatch(/Period\./);
    }
  });

  it('words the days it expects from a start she logged the same way', () => {
    // The variant with no end date, which has the same shape: the day is part of
    // the bleed of a cycle that began on a start she typed in, and it has not
    // arrived. The span reaching it is the learned length rather than her entry,
    // which is a weaker claim about the same day and not a different one, so the
    // sentence and the basis are the ones a continuation gets.
    const estimate = phaseForDate(on('2024-02-10'), '2024-02-12');
    expect(estimate?.phase).toBe('predicted-menstrual');
    expect(estimate?.predictedBleedBasis).toBe('continues-logged-bleed');
    expect(estimate?.dayOfCycle).toBe(3);
    expect(estimate?.summary).toBe(
      'Day 3 of the period you logged starting on 2024-02-10. This day has not arrived yet, so it is still expected rather than a day you have recorded bleeding on.'
    );
  });

  it('reports those same days as a period once they have arrived', () => {
    const inputs = on(ESTIMATED_BLEED_END);
    expect(buildPhaseModel(inputs).menstrualWindow?.end).toBe(ESTIMATED_BLEED_END);
    for (const date of walkDates('2024-02-12', ESTIMATED_BLEED_END)) {
      expect(phaseForDate(inputs, date)?.phase, date).toBe('menstrual');
    }
  });

  it('holds those days back from the other windows before they arrive', () => {
    // Not asserting a bleed on a day is a bound on what the engine says, not a
    // release of that day to whatever else the arithmetic would put there. The
    // estimated bleed is where the fertile window is cut, so the window starts
    // the day after the whole of it either way, and no day the engine expects
    // her to be bleeding on is published as fertile.
    const early = buildPhaseModel(on('2024-02-11'));
    const later = buildPhaseModel(on(ESTIMATED_BLEED_END));
    expect(early.fertileWindow?.start).toBe(addDays(ESTIMATED_BLEED_END, 1));
    expect(early.fertileWindow).toEqual(later.fertileWindow);
    expect(early.premenstrualWindow).toEqual(later.premenstrualWindow);
    for (const date of walkDates('2024-02-10', ESTIMATED_BLEED_END)) {
      expect(phaseForDate(on('2024-02-11'), date)?.phase, date).not.toBe('fertile');
    }
  });

  it('says the same thing on the day she logs the start', () => {
    // The case she will actually meet: she logs a start today, and the app must
    // not tell her she is bleeding for the next four days on the strength of a
    // population average.
    const inputs = on('2024-02-10');
    expect(buildPhaseModel(inputs).menstrualWindow).toEqual({
      start: '2024-02-10',
      end: '2024-02-10',
    });
    expect(phaseForDate(inputs, '2024-02-11')?.phase).not.toBe('menstrual');
  });
});

describe('a logged bleed that runs past the predicted start', () => {
  // The ordering the whole design rests on, at the one point it can be tested:
  // a day that is both inside a bleed she logged and at or past a date the
  // engine predicted. The fact wins in every state of the log, once it is a
  // fact. Before it is one there is nothing to win with: an entry reaching the
  // predicted start is 31 days long, so it is past both bounds on the
  // projection, and the same three days are walked here on both sides of that
  // line.
  const starts = ['2024-01-01', '2024-01-29', '2024-02-26'];
  const entries: DayEntry[] = [
    ...starts.map((date): DayEntry => ({ date, kind: 'period-start' })),
    { date: '2024-03-27', kind: 'period-end' },
  ];
  const { cycles } = deriveCycles({ version: 1, entries }, AFTER_EVERY_START);

  function on(today: string): PhaseInputs {
    return {
      cycles,
      predictedNextStart: '2024-03-25',
      predictionValidThrough: '2024-04-23',
      today,
      lutealLength: learnLutealLength(),
      periodLength: learnPeriodLength(observedPeriodLengths(cycles, today)),
      confidence: 0.5,
      confidenceTier: 'moderate',
    };
  }

  it('claims none of it before those days have happened', () => {
    // An end logged for 2024-03-27 with today on the 24th is an entry about
    // three days that have not arrived. The bleed is drawn to today and stops,
    // and it is not carried across the start the engine predicts either, because
    // the next cycle begins there and a bleed the engine has not been told about
    // is a bleed of that one. So those days are the bleed expected next, from
    // its first day, and none of them reads as a period she recorded.
    const inputs = on('2024-03-24');
    expect(phaseForDate(inputs, '2024-03-24')?.phase).toBe('menstrual');
    expect(buildPhaseModel(inputs).menstrualWindow?.end).toBe('2024-03-24');
    for (const date of walkDates('2024-03-25', '2024-03-27')) {
      const estimate = phaseForDate(inputs, date);
      expect(estimate?.phase, date).toBe('predicted-menstrual');
      expect(estimate?.predictedBleedBasis, date).toBe('expected-next-bleed');
      expect(estimate?.dayOfCycle, date).toBe(diffDays('2024-03-25', date) + 1);
      expect(estimate?.summary, date).not.toMatch(/Period\./);
    }
  });

  it('starts the bleed it expects next at its first day, never partway in', () => {
    // The counter a calendar would draw a day-N-of-M ring from. Her entry covers
    // the predicted start and the two days after it, so those days could have
    // been taken from the front of that run and left it beginning at day 4. They
    // cannot be: the run is reported only while the log is current, which is a
    // state today has not reached the predicted start in, and the bleed of the
    // cycle she is in is not projected as far as that start. Walked from the day
    // before her entry ends to a day past the whole thing, so a today that broke
    // it would have to be missed rather than merely not sampled.
    let daysWithARun = 0;
    for (const today of walkDates('2024-03-20', '2024-03-26')) {
      const inputs = on(today);
      const run = walkDates('2024-02-26', '2024-04-10')
        .map((date) => phaseForDate(inputs, date))
        .filter((estimate) => estimate?.predictedBleedBasis === 'expected-next-bleed')
        .map((estimate) => estimate?.dayOfCycle);
      // Past the predicted start the log is late, and a spent prediction is not
      // reported at all, so there is no run to check on those days.
      if (run.length === 0) continue;
      daysWithARun += 1;
      expect(run, today).toEqual([1, 2, 3, 4, 5]);
    }
    expect(daysWithARun).toBe(5);
  });

  it('reads as the bleed she logged the moment those days arrive', () => {
    // The same three days, once the calendar has caught up with her entry. The
    // fact outranks the prediction: 2024-03-25 is the predicted start and she
    // has recorded bleeding on it, so it is a period day rather than a
    // predicted one, and the sentence is the one a logged bleed gets.
    const inputs = on('2024-03-27');
    expect(buildPhaseModel(inputs).menstrualWindow?.end).toBe('2024-03-27');
    for (const date of ['2024-03-25', '2024-03-27']) {
      expect(phaseForDate(inputs, date)?.phase, date).toBe('menstrual');
    }
    expect(phaseForDate(inputs, '2024-03-25')?.summary).toBe(
      `Day ${diffDays('2024-02-26', '2024-03-25') + 1}. Period.`
    );
  });

  it('leaves the length of the bleed it predicts to the learned estimate', () => {
    // The two are different questions and the logged end answers only the first.
    // This entry runs 31 days; the bleed the engine expects next is one it has
    // been told nothing about, so it is the learned 5 days, ending 2024-03-29.
    const inputs = on('2024-03-24');
    expect(diffDays('2024-02-26', '2024-03-27') + 1).toBe(31);
    const past = phaseForDate(inputs, '2024-03-29');
    expect(past?.phase).toBe('predicted-menstrual');
    // Two days past the end she typed, and the bleed expected next runs to it
    // because that bleed is the learned length rather than hers.
    expect(past?.predictedBleedBasis).toBe('expected-next-bleed');
    expect(past?.dayOfCycle).toBe(diffDays('2024-03-25', '2024-03-29') + 1);
    expect(phaseForDate(inputs, '2024-03-30')).toBeUndefined();
  });

  it('reads as the bleed she logged rather than as being late', () => {
    const inputs = on('2024-03-29');
    expect(buildPhaseModel(inputs).isLate).toBe(true);
    expect(phaseForDate(inputs, '2024-03-25')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-03-27')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-03-28')?.phase).toBe('late');
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
  const { cycles } = deriveCycles({ version: 1, entries }, AFTER_EVERY_START);
  const lastStart = cycles[cycles.length - 1]?.startDate as string;
  const inputs: PhaseInputs = {
    cycles,
    // 22 day cycles fit a mean of 22.69, which rounds to a 23 day cycle.
    predictedNextStart: addDays(lastStart, 23),
    predictionValidThrough: NEVER_STALE,
    // Past the end of the current bleed, so the whole of it has happened and the
    // collision under test is the one between two full windows. The bound on a
    // logged end that runs into the future has its own case below.
    today: addDays(lastStart, BLEED_DAYS),
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles, addDays(lastStart, BLEED_DAYS))),
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

  it('keeps the ovulation estimate inside the window it is the middle of', () => {
    const ovulation = model.estimatedOvulationDate as string;
    expect(diffDays(model.fertileWindow?.start as string, ovulation)).toBeGreaterThanOrEqual(0);
    expect(diffDays(ovulation, model.fertileWindow?.end as string)).toBeGreaterThanOrEqual(0);
  });
});

describe('a cycle short enough that the bleed covers the ovulation estimate', () => {
  /**
   * The far end of the same family. 18 day cycles with a logged 7 day bleed put
   * the estimated ovulation on day 6, inside the bleed rather than just before
   * it, so cutting the fertile window against the bleed takes its middle and not
   * only its front. What is left is a stray day and an ovulation date the same
   * engine calls a period day, which is a model disagreeing with itself, so
   * neither is published.
   */
  const CYCLE_DAYS = 18;
  const BLEED_DAYS = 7;
  const entries: DayEntry[] = [];
  for (let i = 0, date = '2024-01-01'; i < 13; i += 1, date = addDays(date, CYCLE_DAYS)) {
    entries.push({ date, kind: 'period-start' });
    entries.push({ date: addDays(date, BLEED_DAYS - 1), kind: 'period-end' });
  }
  const { cycles } = deriveCycles({ version: 1, entries }, AFTER_EVERY_START);
  const lastStart = cycles[cycles.length - 1]?.startDate as string;
  const predicted = addDays(lastStart, CYCLE_DAYS);
  const inputs: PhaseInputs = {
    cycles,
    predictedNextStart: predicted,
    predictionValidThrough: NEVER_STALE,
    // Past the end of the current bleed, for the same reason as the case above.
    today: addDays(lastStart, BLEED_DAYS),
    lutealLength: learnLutealLength(),
    periodLength: learnPeriodLength(observedPeriodLengths(cycles, addDays(lastStart, BLEED_DAYS))),
    confidence: 0.5,
    confidenceTier: 'moderate',
  };
  const model = buildPhaseModel(inputs);

  it('is a history where the bleed really does cover the ovulation estimate', () => {
    // Without this the test could pass by describing a cycle with room for both.
    const ovulation = addDays(predicted, -LUTEAL_PRIOR_MEAN_DAYS);
    expect(diffDays(ovulation, model.menstrualWindow?.end as string)).toBeGreaterThanOrEqual(0);
  });

  it('publishes neither the ovulation estimate nor a window with no middle', () => {
    expect(model.fertileWindow).toBeUndefined();
    expect(model.estimatedOvulationDate).toBeUndefined();
  });

  it('keeps the windows it can still stand behind', () => {
    // Dropping the fertility estimate is not a reason to stop describing the
    // bleed she logged or the run-up to the next expected start.
    expect(model.menstrualWindow?.start).toBe(lastStart);
    expect(model.premenstrualWindow).toBeDefined();
  });

  it('calls no day of the cycle fertile either', () => {
    // Asserted as which phase each day is rather than as which one it is not,
    // so the loop cannot pass by the days having no phase at all.
    for (let i = 0; i < CYCLE_DAYS; i += 1) {
      const date = addDays(lastStart, i);
      expect(['menstrual', 'follicular', 'luteal', 'premenstrual'], date).toContain(
        phaseForDate(inputs, date)?.phase
      );
    }
  });

  it('names no fertile window in the sentences for the days around it', () => {
    // The summaries for follicular and luteal quote the fertile window when
    // there is one. There is not, so they must not.
    for (let i = 0; i < CYCLE_DAYS; i += 1) {
      const date = addDays(lastStart, i);
      expect(phaseForDate(inputs, date)?.summary, date).not.toMatch(/fertile|ovulation/i);
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
    // start still gets a phase rather than being blanked or painted late.
    const inputs = on('2024-03-31');
    expect(phaseForDate(inputs, '2024-03-31')?.phase).toBe('late');
    expect(phaseForDate(inputs, '2024-03-12')?.phase).toBe('follicular');
    expect(phaseForDate(inputs, '2024-02-27')?.phase).toBe('menstrual');
    expect(phaseForDate(inputs, '2024-01-16')?.phase).toBe('fertile');
  });

  it('withholds the fertile reading per day, not just on the model', () => {
    // The disagreement first, so the test cannot pass by describing a cycle
    // that had no fertile days to withhold. While the log is current these
    // exact days are fertile and the model publishes the window they sit in.
    const whileCurrent = on('2024-03-12');
    expect(buildPhaseModel(whileCurrent).fertileWindow).toBeDefined();
    for (const date of ['2024-03-07', '2024-03-12', '2024-03-13']) {
      expect(phaseForDate(whileCurrent, date)?.phase, date).toBe('fertile');
    }

    // Once today is late the model drops the window, and handing the same days
    // back one calendar cell at a time would be that suppression undone. They
    // keep a phase, since nothing has contradicted the days themselves, but it
    // is the follicular or luteal half they sit in rather than fertile.
    const late = on('2024-03-31');
    expect(buildPhaseModel(late).fertileWindow).toBeUndefined();
    for (const date of ['2024-03-07', '2024-03-12', '2024-03-13']) {
      const estimate = phaseForDate(late, date);
      expect(estimate?.phase, date).not.toBe('fertile');
      expect(['follicular', 'luteal'], date).toContain(estimate?.phase);
      expect(estimate?.summary, date).not.toMatch(/fertile|ovulation/i);
    }
  });

  it('withholds the premenstrual reading the same way, for the same reason', () => {
    // The premenstrual run-up is indexed backward from the same contradicted
    // cycle end, and the model drops it alongside the fertile window.
    expect(phaseForDate(on('2024-03-24'), '2024-03-24')?.phase).toBe('premenstrual');
    const late = on('2024-03-31');
    expect(buildPhaseModel(late).premenstrualWindow).toBeUndefined();
    expect(phaseForDate(late, '2024-03-24')?.phase).toBe('luteal');
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
    // Named as the phase each day does get rather than as the one it does not,
    // so the loop cannot pass by those days coming back with no phase at all.
    // A completed cycle is bounded by a start she logged, so today being late
    // says nothing about it.
    const inputs = on('2024-04-10');
    const expectations: Array<[string, string]> = [
      ['2024-01-01', 'menstrual'],
      ['2024-01-16', 'fertile'],
      ['2024-01-28', 'premenstrual'],
      ['2024-02-25', 'premenstrual'],
    ];
    for (const [date, phase] of expectations) {
      expect(phaseForDate(inputs, date)?.phase, date).toBe(phase);
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
    for (const date of walkDates(lastStart, '2024-08-15')) {
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
    for (const date of walkDates('2024-05-20', '2024-08-15')) {
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

  it('publishes no window the day-by-day answer disagrees with, in any state', () => {
    // The model and phaseForDate read the same windows, so painting the ranges
    // and asking day by day cannot differ about a day of the current cycle,
    // which is the cycle the model describes and so the domain of the whole
    // invariant. The walk starts at the last logged start for that reason; the
    // test below covers what happens before it. Walked in all three states
    // rather than in the one that changed: while late the model dropped the
    // fertile window and phaseForDate went on handing the same days back one
    // cell at a time, and what let that through was checking the state being
    // edited and not its siblings.
    const inWindow = (date: string, range?: { start: string; end: string }) =>
      range !== undefined && diffDays(range.start, date) >= 0 && diffDays(date, range.end) >= 0;
    for (const today of ['2024-06-10', validThrough, '2024-10-01']) {
      const inputs = on(today);
      const model = buildPhaseModel(inputs);
      for (const date of walkDates(lastStart, '2024-07-20')) {
        const phase = phaseForDate(inputs, date)?.phase;
        const where = `${today} ${date}`;
        expect(phase === 'menstrual', where).toBe(inWindow(date, model.menstrualWindow));
        expect(phase === 'fertile', where).toBe(inWindow(date, model.fertileWindow));
        expect(phase === 'premenstrual', where).toBe(inWindow(date, model.premenstrualWindow));
      }
    }
  });

  it('never claims a predicted bleed is a logged one, in any state', () => {
    // The eighth state walked against the same rule, with each state carrying
    // the assertion that state can fail. While the log is current the predicted
    // bleed is claimed, for exactly the days it covers, and none of them is a
    // day the model's menstrual window holds, so the bleed she logged and the
    // one she has not cannot be the same day. Once the predicted start has
    // passed with nothing logged the claim is spent and no day reports it at
    // all: asserting that is what the other two states are here for. Skipping
    // the days that do not match would have made them read as coverage while
    // only the first could fail.
    const predictedBleed = walkDates(
      predictedNextStart,
      addDays(predictedNextStart, PERIOD_PRIOR_MEAN_DAYS - 1)
    );
    for (const today of ['2024-06-10', validThrough, '2024-10-01']) {
      const inputs = on(today);
      const menstrualWindow = buildPhaseModel(inputs).menstrualWindow;
      const claimed = walkDates(lastStart, '2024-07-20').filter(
        (date) => phaseForDate(inputs, date)?.phase === 'predicted-menstrual'
      );
      expect(claimed, today).toEqual(today === '2024-06-10' ? predictedBleed : []);
      for (const date of claimed) {
        expect(diffDays(date, menstrualWindow?.end as string), `${today} ${date}`).toBeLessThan(0);
      }
    }
  });

  it('classifies completed cycles against their own windows, whatever today is', () => {
    // The walk above starts at the last logged start, so it cannot see this
    // region at all, and a test that cannot reach a region is not evidence
    // about it. A completed cycle is bounded by a next start that really
    // happened, so its windows are anchored to fact and today cannot touch
    // them. That is why the agreement between the model and the per-day answer
    // is an invariant about the current cycle: the model describes no other.
    const current = on('2024-06-10');
    const late = on(validThrough);
    const stale = on('2024-10-01');
    expect(buildPhaseModel(late).fertileWindow).toBeUndefined();
    expect(buildPhaseModel(stale).fertileWindow).toBeUndefined();

    let fertileDays = 0;
    for (const date of walkDates(starts[0] as string, addDays(lastStart, -1))) {
      const phase = phaseForDate(current, date)?.phase;
      expect(ORDINARY, date).toContain(phase);
      expect(phaseForDate(late, date)?.phase, date).toBe(phase);
      expect(phaseForDate(stale, date)?.phase, date).toBe(phase);
      if (phase === 'fertile') fertileDays += 1;
    }
    // Not vacuous: there really are days in there that come back fertile while
    // the model, late and then stale, publishes no fertile window at all.
    expect(fertileDays).toBeGreaterThan(0);
  });

  it('is contiguous stale from the last logged start to today, and blank after it', () => {
    // The one deliberate difference from late: stale covers the days before the
    // predicted start too, because those readings were indexed off a cycle end
    // now known not to have held. The bleed she logged the start of survives,
    // because it is a fact rather than a prediction.
    const today = '2024-10-01';
    const inputs = on(today);
    for (const date of walkDates('2024-04-22', '2024-11-01')) {
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
