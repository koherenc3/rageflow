/**
 * Synthetic cycle generators with known ground truth.
 *
 * Every number this file produces comes from a seeded pseudo-random generator,
 * so the fixtures are deterministic and the tests cannot flake. Nothing here is
 * real data, and nothing that resembles real data belongs in this repository:
 * it is public.
 *
 * This lives under src/engine because it is pure TypeScript with the same no
 * React, no browser rule as the rest of the engine. It is not shipped to the
 * app.
 */

import { addDays, type ISODate } from '../date';

/** mulberry32. Small, fast, and good enough for fixtures. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. Returns one standard normal draw per call. */
export function standardNormal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Cycle lengths are whole days and cannot be arbitrarily small. Clamping to a
 * plausible physiological range stops a heavy-tailed draw from producing a
 * fixture no human would generate.
 */
const MIN_GENERATED_CYCLE_DAYS = 15;
const MAX_GENERATED_CYCLE_DAYS = 90;

function drawLength(random: () => number, meanDays: number, sdDays: number): number {
  const raw = Math.round(meanDays + sdDays * standardNormal(random));
  return Math.min(MAX_GENERATED_CYCLE_DAYS, Math.max(MIN_GENERATED_CYCLE_DAYS, raw));
}

export interface RegularCycleSpec {
  count: number;
  meanDays: number;
  sdDays: number;
  seed: number;
}

/** Cycle lengths drawn around a fixed mean. */
export function generateCycleLengths(spec: RegularCycleSpec): number[] {
  const random = createRandom(spec.seed);
  const lengths: number[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    lengths.push(drawLength(random, spec.meanDays, spec.sdDays));
  }
  return lengths;
}

export interface DriftingCycleSpec {
  count: number;
  /** Mean of the first cycle. */
  startMeanDays: number;
  /** Mean of the last cycle. The mean moves linearly between the two. */
  endMeanDays: number;
  sdDays: number;
  seed: number;
}

/**
 * Cycle lengths whose mean moves linearly over the run. This is the fixture
 * that recency weighting exists for: an unweighted model averages the whole
 * history and lags behind.
 */
export function generateDriftingCycleLengths(spec: DriftingCycleSpec): number[] {
  const random = createRandom(spec.seed);
  const lengths: number[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    const t = spec.count === 1 ? 0 : i / (spec.count - 1);
    const meanDays = spec.startMeanDays + t * (spec.endMeanDays - spec.startMeanDays);
    lengths.push(drawLength(random, meanDays, spec.sdDays));
  }
  return lengths;
}

/** The mean this generator was aiming at for cycle `index`. */
export function driftingMeanAt(spec: DriftingCycleSpec, index: number): number {
  const t = spec.count === 1 ? 0 : index / (spec.count - 1);
  return spec.startMeanDays + t * (spec.endMeanDays - spec.startMeanDays);
}

/**
 * Merge the cycle at `index` with the one after it, as happens when a period
 * start never gets logged. Ground truth for the skip detection fixture.
 */
export function mergeCycleAt(lengths: readonly number[], index: number): number[] {
  if (index < 0 || index + 1 >= lengths.length) {
    throw new RangeError(`Cannot merge cycle ${index} of ${lengths.length}`);
  }
  const merged = [...lengths];
  merged.splice(index, 2, (lengths[index] as number) + (lengths[index + 1] as number));
  return merged;
}

/**
 * Turn cycle lengths into the period start dates a user would actually log.
 * `n` lengths produce `n + 1` starts.
 */
export function startDatesFromLengths(firstStart: ISODate, lengths: readonly number[]): ISODate[] {
  const dates: ISODate[] = [firstStart];
  let current = firstStart;
  for (const length of lengths) {
    current = addDays(current, length);
    dates.push(current);
  }
  return dates;
}
