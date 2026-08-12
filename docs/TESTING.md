# Testing

## Running the tests

```
npm test             # vitest run, one pass, what CI runs
npm run test:watch   # vitest in watch mode
npx vitest run src/engine/__tests__/properties.test.ts   # one file
```

Tests run in a plain node environment with no DOM shim. That is deliberate: the engine must not need a browser, and removing the shim means an accidental `document` reference fails loudly instead of quietly working in tests and breaking on a server.

The whole suite is a few hundred milliseconds. There is no excuse for not running it.

## No real data, ever

This repository is public and contains zero health data. Every number in every test comes from a seeded pseudo-random generator in `src/engine/testing/synthetic.ts`. Nothing in the test suite is, or resembles, anyone's real cycle history, and nothing that does may be added. See `CLAUDE.md`.

## The synthetic fixtures

`src/engine/testing/synthetic.ts` provides:

- `createRandom(seed)` - mulberry32. Small, fast, and fully deterministic.
- `standardNormal(random)` - Box-Muller, one standard normal draw per call.
- `generateCycleLengths({count, meanDays, sdDays, seed})` - cycle lengths around a fixed mean, clamped to a plausible 15 to 90 day range.
- `generateDriftingCycleLengths({count, startMeanDays, endMeanDays, sdDays, seed})` - cycle lengths whose mean moves linearly over the run.
- `mergeCycleAt(lengths, index)` - merges two adjacent cycles, which is exactly what a missed log looks like in the data.
- `startDatesFromLengths(firstStart, lengths)` - turns cycle lengths into the period start dates a user would actually log. `n` lengths give `n + 1` starts.

Everything is seeded, so a failure is a real regression and never a flake. If a test needs randomness, it needs a seed.

`src/engine/__tests__/fixtures.test.ts` builds these shapes and asserts the behaviour each one is meant to show:

| Fixture                                  | Asserted                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular, mean 28, sd 1                   | Learns the true mean, 80% interval no wider than 10 days, mean absolute error under 1.5 days from cycle 6 onward, `high` confidence tier, no flags                           |
| Irregular, mean 31, sd 7                 | Intervals wider than the regular case at the same cycle count, lower confidence, pooled 80% coverage between 0.70 and 0.95                                                   |
| Drifting, 27 rising to 33 over 12 cycles | Recency-weighted fit sits above an unweighted one, lands closer to the recent truth, and has lower out-of-sample error over the second half. Holds across five seeds         |
| Two cycles recorded as one               | Gap flagged and excluded, and neither the mean nor the variance is poisoned. Left in, the merged gap more than doubles the predictive spread; handled, it moves it under 20% |
| Long cycles, around 45 days              | Clinical flag fires on every cycle over 45 days, no missed-log false positives, 80% interval under 25 days, every output finite                                              |
| Fewer than three cycles                  | Cold-start wording present and explicit, intervals wide, confidence under 0.25, two cycles strictly wider than eight                                                         |

## The two headline properties

These are the product claim, asserted directly in `src/engine/__tests__/properties.test.ts`.

### 1. Mean absolute error falls as cycle count rises. The thing learns.

Measured over a population of 40 simulated users with typical cycle lengths spread from 24 to 35 days and an individual variability of 2 days. The spread matters: someone whose cycles happen to be exactly 29 days long has nothing to teach a model whose prior is centred on 29, so a population centred on the prior would make the property untestable rather than true.

Asserted:

- Mean absolute error over cycles 10 and later is under 75% of the error over the first three cycles.
- It falls monotonically across four consecutive blocks of history (cycles 0 to 1, 2 to 4, 5 to 8, 9+).
- It also falls for a tightly regular population (sd 1 day).
- The 80% interval width falls too, so the improvement is in the stated uncertainty and not just in the point estimate.

The error numbers come from `buildCalibration`, which replays the log using only the data available before each outcome, so they are genuinely out of sample.

### 2. An 80% interval contains the truth about 80% of the time. The thing is honest.

Measured over a population of 80 simulated users, typical cycle lengths from 25 to 33 days, individual variability from 3 to 7 days. That range brackets the prior's own 5 day standard deviation. Sample size is over 1000 graded predictions, which the test asserts before it asserts anything else.

Asserted:

- Pooled 80% coverage between 0.75 and 0.90.
- Pooled 50% coverage between 0.45 and 0.65.
- Coverage above 0.72 for each individual variability level from 3 to 7 days, checked separately.
- Mean 80% interval width under 20 days, so coverage is not achieved by making the intervals useless.
- Coverage above 0.70 from cycle 6 onward even for a cohort whose true cycle length is 38 to 41 days, far from the prior. Early predictions there will miss; what matters is that the model recovers rather than staying confidently wrong.

**Why the bands are asymmetric.** The engine over-covers for very regular cycles: with a prior mean variance of 25 and an effective sample size that saturates around 9 cycles, someone whose cycles vary by a day gets an 80% interval that covers close to 100%. Being wider than claimed is a much smaller sin than being narrower, so the tolerance allows over-coverage and is tight against under-coverage. Pooled coverage across the mixed population lands near 0.83.

## The other test files

| File                  | Covers                                                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date.test.ts`        | Parsing, formatting, validation, day-number round trips over 60000 days, month and year boundaries, leap years including 1900-style century rules, and daylight saving transitions in six zones. Also that `todayLocal` reads local calendar fields at 23:30 rather than the UTC instant |
| `stats.test.ts`       | `logGamma`, `logBeta`, the regularised incomplete beta, the Student-t CDF against its closed forms at 1 and 2 degrees of freedom, and the Student-t quantile against 17 published critical values plus the normal limit, inverse-of-CDF, symmetry, and monotonicity                      |
| `cycles.test.ts`      | Cycle derivation from raw start dates, sorting and de-duplication, end-date attachment, skip detection including the cases where it must _not_ fire, and clinical flags including the exact boundary values                                                                              |
| `cycleLength.test.ts` | Recency weights, the prior, hand-computed conjugate updates for one and two observations, and the behaviour of the predictive and its intervals                                                                                                                                          |
| `phases.test.ts`      | The normal-normal learned lengths, the luteal update hook, the phase of every day of a worked 28 day cycle, and the `late` and `stale` states either side of their boundary, including that both key off today rather than the date being asked about                                    |
| `calibration.test.ts` | Grading, summarising, the widening rule and its cap and shrinkage, and that the replay does not leak future information backwards                                                                                                                                                        |
| `analysis.test.ts`    | The public `analyze` surface, purity of the function, entry-order independence, forward compatibility with unknown entry kinds, and both gates of the staleness bound                                                                                                                    |
| `purity.test.ts`      | Scans `src/engine` source and fails on any non-relative import, dynamic import, browser global, or UTC date serialisation. Also that `new Date()` appears exactly once, in `todayLocal`                                                                                                  |

## Adding a test

- Seed anything random.
- If you assert a numeric threshold, say in a comment where the number came from.
- If a threshold is a statistical one, measure it over a population rather than one run. A single 16 cycle history is not a sample.

## Related

- [[RESEARCH]] for what the model is and where its limits are.
- [[DECISIONS]] for why the engine is testable without a browser.
