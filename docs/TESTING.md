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

This repository is public and contains zero health data. Nothing in the test suite is, or resembles, anyone's real cycle history, and nothing that does may be added. See `CLAUDE.md`.

Two rules, and they are not the same rule:

- Every generated cycle history and every statistical fixture comes from the seeded generator in `src/engine/testing/synthetic.ts`. Anything measured over a population, anything with a spread, anything where the numbers stand in for a real log: that is where it comes from, and a test that needs randomness needs a seed.
- Hand-written literal dates are allowed in deterministic unit tests, and several worked examples use them: `2024-01-01` plus exact 28 day steps, a mistyped end date, the boundary of a clinical flag. They must stay obviously synthetic. Routing those through a generator would make the tests worse, because the whole point of them is that the arithmetic is checkable by hand.

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

| File                  | Covers                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `date.test.ts`        | Parsing, formatting, validation, day-number round trips over 60000 days, month and year boundaries, leap years including 1900-style century rules, and daylight saving transitions in six zones. Also that `todayLocal` reads local calendar fields at 23:30 rather than the UTC instant                                                                                                                                       |
| `stats.test.ts`       | `logGamma`, `logBeta`, the regularised incomplete beta, the Student-t CDF against its closed forms at 1 and 2 degrees of freedom, and the Student-t quantile against 17 published critical values plus the normal limit, inverse-of-CDF, symmetry, and monotonicity                                                                                                                                                            |
| `cycles.test.ts`      | Cycle derivation from raw start dates, sorting and de-duplication, end-date attachment, starts dated after today being left out and reported, skip detection including the cases where it must _not_ fire, and clinical flags including the exact boundary values                                                                                                                                                              |
| `cycleLength.test.ts` | Recency weights, the prior, hand-computed conjugate updates for one and two observations, and the behaviour of the predictive and its intervals                                                                                                                                                                                                                                                                                |
| `phases.test.ts`      | The normal-normal learned lengths, the luteal update hook, the phase of every day of a worked 28 day cycle, the `late` and `stale` states either side of their boundary, including that both key off today rather than the date being asked about, that a bleed the engine predicted and never saw arrive is not painted onto the calendar, and that an end date logged for days that have not happened is drawn only to today |
| `confidence.test.ts`  | The ceiling the model can attain, that the reported confidence climbs towards it over years of regular cycles without landing on it, that it is zero only with nothing to fit, that it keeps falling past the point where the spread is useless, and that the cold start tiers are left alone                                                                                                                                  |
| `calibration.test.ts` | Grading, summarising, the widening rule and its cap and shrinkage, and that the replay does not leak future information backwards                                                                                                                                                                                                                                                                                              |
| `analysis.test.ts`    | The public `analyze` surface, purity of the function, entry-order independence, forward compatibility with unknown entry kinds, both gates of the staleness bound, and the three tiers of the prediction either side of the 80% interval and the staleness bound                                                                                                                                                               |
| `purity.test.ts`      | Scans `src/engine` source and fails on any non-relative import, dynamic import, browser global, or UTC date serialisation. Also that `new Date()` appears exactly once, in `todayLocal`                                                                                                                                                                                                                                        |

## Outside the engine

| File                         | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage/repository.test.ts` | The IndexedDB repository against `fake-indexeddb`: the version derived from the migration ladder, the compound key making a repeat log one fact rather than two, deletes hitting only the entry named, a mistyped date moving in one transaction and carrying `meta` with it, a move onto a day that already holds that kind being refused with the log left byte-identical, a move from a day holding nothing writing nothing, merge adding without touching what is there, an unrecognised entry kind being stored rather than discarded, and the sort placing an unreadable date last instead of throwing |
| `storage/backup.test.ts`     | The file format, every way a file can be refused, and the round trip: a seeded synthetic history out through the writer, back in through the parser and the repository, asserted to produce a log the engine analyses identically. Also that importing the same file twice is a no-op, and that a row the engine itself cannot read still survives the trip                                                                                                                                                                                                                                                  |
| `lib/display.test.ts`        | The weekday computed from the day number rather than from `Date`, the range and relative-day wording, that a phase the engine merely expects is marked as an estimate and a logged one is not, that a `NaN` has no percentage and no day count, and that `humanizeDates` respells dates in the engine's own sentences without moving a word                                                                                                                                                                                                                                                                  |
| `lib/theme.test.ts`          | Reads `src/app/globals.css` and asserts the three things about it that fail silently: that it names its Tailwind source root rather than relying on automatic detection, that every phase tone has both its colour and its soft variant in both colour schemes, and that no token is defined in the dark block alone                                                                                                                                                                                                                                                                                         |

`fake-indexeddb` is the real IndexedDB algorithms in memory, not a stub of the repository's own API, so the transaction and key behaviour these tests rely on is the behaviour the browser will show. It needs no DOM, so the whole suite still runs in a plain node environment. `storage/__tests__/support.ts` hands out the repositories those two files use and deletes the database after each test, closing every connection first: an open connection blocks a delete, and a blocked delete never settles, so getting that wrong hangs the whole suite rather than failing one test.

There are no component render tests. The screens are checked in a real browser at iPhone viewport sizes, in both colour schemes, against the states the engine can actually produce: empty, one start logged, a populated history, late, and stale.

## Adding a test

- Seed anything random.
- If you assert a numeric threshold, say in a comment where the number came from.
- If a threshold is a statistical one, measure it over a population rather than one run. A single 16 cycle history is not a sample.

## Related

- [[RESEARCH]] for what the model is and where its limits are.
- [[DECISIONS]] for why the engine is testable without a browser.
