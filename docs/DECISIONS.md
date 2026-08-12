# Decisions

One entry per architectural decision, with the reasoning that led to it. If a decision gets reversed, edit the entry and say why rather than deleting it.

## Web app rather than a native iOS app

**Decision.** Build a Next.js PWA installed to the iPhone home screen, not a native iOS app.

**Reasoning.** The app is one screen and a button. Native buys a home screen icon, offline support, and push notifications; a PWA gives the first two outright and the third with more effort. Against that, native costs an Apple developer account, Xcode, a signing setup, App Store review for a single-user app that will never be listed, and a rebuild-and-reinstall cycle for every change. A PWA deploys by pushing to a branch.

The one thing native would genuinely buy is HealthKit, and the whole point of this app is that her data does not go anywhere she did not put it.

**Consequences.** Push notifications are deferred, not free. iOS standalone mode has quirks (safe areas, no pull-to-refresh, storage eviction under pressure) that task 3 has to handle. Storage eviction in particular is why the encrypted backup exists.

## Local-first rather than a server database

**Decision.** Her data lives on her phone. The server holds nothing but ciphertext, and only for backup.

**Reasoning.** This is menstrual health data for one person. There is no product reason for it to leave the device: there is no sharing, no sync between users, no analytics, no aggregation. A server database would add a class of risk (breach, subpoena, my own operational mistakes) in exchange for nothing she asked for.

Local-first also makes the app fast and offline by default, which matters for something opened for four seconds at a time.

**Consequences.** Backup is her problem unless we solve it, so task 3 solves it with browser-side encryption. Losing the phone without a backup loses the history. There is no cross-device story, and that is fine because there is one device.

## The engine is decoupled from React

**Decision.** `src/engine/` is pure TypeScript with zero imports from React, Next, or any browser API. Enforced by `no-restricted-imports` and `no-restricted-globals` in `eslint.config.mjs`, and by `src/engine/__tests__/purity.test.ts`, which scans the source and would catch a disabled lint rule.

**Reasoning.** The engine is the part of this app with real complexity and real consequences: Bayesian updating, credible intervals, skip detection, self-calibration. That code needs to be exercised hard, and it needs to be exercised without a render tree, a test renderer, a DOM shim, or a component in the way. `vitest run` in a plain node environment runs the whole suite in under a second, which means the tests actually get run.

It also keeps the option open. The engine could move to a worker, to a server function, or to a different framework entirely without touching a line of its logic.

**Consequences.** The engine cannot read storage or the clock without being handed them. `analyze()` takes an optional `today`, which is exactly what makes the tests deterministic. The UI layer owns everything platform-shaped.

## Calendar dates rather than timestamps

**Decision.** Every date in the system is a local calendar date stored as a `YYYY-MM-DD` string. No `Date` objects in the data model, no epoch timestamps, no UTC.

**Reasoning.** "My period started on the 3rd" is a fact about a square on a wall calendar. It has no time of day and no time zone. The moment it becomes an instant, three bugs become possible: logging at 11pm shows tomorrow's date, a cycle spanning a daylight saving transition measures 27 or 29 days instead of 28, and travelling across a time zone silently rewrites history.

All three are the kind of bug that makes a user stop trusting an app, and none of them are worth the risk for zero benefit. There is no operation this app performs that needs sub-day resolution.

`src/engine/date.ts` does all arithmetic through an integer day number (Howard Hinnant's civil-from-days), never through `Date` addition, so every operation is exact by construction rather than correct by luck. The DST cases are covered directly in `src/engine/__tests__/date.test.ts`.

**Consequences.** One permitted `new Date()` in the engine, as the default argument of `todayLocal()`, which immediately reads local calendar fields and returns a string. `toISOString()` is banned outright and the purity test checks for it.

## Normal-Inverse-Gamma rather than a mean and a standard deviation

**Decision.** Model cycle length with a Normal-Inverse-Gamma conjugate prior, producing a Student-t posterior predictive.

**Reasoning.** The app's core honesty claim is that it says how sure it is. A sample mean and sample standard deviation over two cycles would happily report a two day interval, which is a lie. The Student-t predictive is naturally wide when data is thin and tightens as cycles accumulate, so confidence falls out of the arithmetic instead of being a heuristic somebody tuned and then had to defend.

Conjugacy also means the update is closed form: no sampler, no convergence to check, no dependency.

**Consequences.** The prior's influence is real and lasting, especially combined with recency weighting. See the known limitations in [[RESEARCH]].

## Recency weighting with a six cycle half life

**Decision.** Weight observation `i` by `0.5 ^ ((n - i) / 6)`.

**Reasoning.** Cycle length genuinely drifts with age, weight, stress, and postpartum recovery. An unweighted mean over all history would lag real change by years. Six cycles is roughly half a year, which tracks drift without letting one odd cycle dominate. The drifting fixture in [[TESTING]] shows the weighted fit beating an unweighted one on out-of-sample error.

**Consequences.** The effective sample size saturates at about 9.2 cycles, so the prior never fully washes out. Documented under known limitations in [[RESEARCH]].

## Cycles are derived, never stored

**Decision.** The persisted document is a flat list of dated entries. Cycles are recomputed on every read.

**Reasoning.** A cycle is the interval between two logged starts. Storing it would create a second source of truth that can drift out of sync with the only thing she actually typed. When she corrects a mistyped start date, every cycle around it has to change, and derivation gets that for free.

**Consequences.** Every read runs the full derivation and the calibration replay. Both are O(n) or O(n squared) in the number of cycles, where n is at most a few hundred over a lifetime, so this costs nothing.

## Skip detection lives in the model, not the UI

**Decision.** `deriveCycles` flags suspected missed logs, excludes them from the fit, and exposes the flag for the UI to ask about.

**Reasoning.** A missed log is not a UI presentation issue, it is a data quality issue that corrupts the variance estimate, and the variance estimate is what every interval in the app is made of. One 56 day gap in an otherwise regular history roughly triples the predictive spread. Handling it after the fit has already been poisoned is too late.

**Consequences.** Two tuned constants (`SKIP_MEDIAN_MULTIPLE`, `SKIP_PREDICTIVE_SD_THRESHOLD`) and a minimum history before detection turns on, all documented in `src/engine/constants.ts`. False positives are possible for genuinely very irregular cycles, which is why the flag is a question rather than a silent deletion.

## One logged end date is weak evidence about period length

**Decision.** Two things, in that order. `PERIOD_OBSERVATION_SD_DAYS` is 3, twice the prior's own 1.5 day spread, so a single logged end date moves the learned period length one fifth of the way towards what she typed. On top of that, an end date more than `MAX_FITTABLE_PERIOD_LENGTH_DAYS` after the start is kept on the derived cycle and shown, but left out of the fit entirely.

**Reasoning.** An end date is one hand-typed self-report, and the first version trusted it about 2.25 to 1 over the population prior, which is the wrong posture for a value tapped in on a phone. Both of its error modes are multi-day: the day she calls the end is genuinely fuzzy, and a mistyped digit moves the date by a week. At the old weighting one 15 day entry pulled the learned length to 11.9, `windowsFor` rounded that to a 12 day menstrual window, and because `classify` tests menstrual before fertile the app reported "Period." across the front of its own estimated fertile window. The bound alone did not fix that, it only moved it below the threshold, so the weighting is the fix and the bound is the backstop for values that are not evidence about her period at all.

**Consequences.** Learned period length now moves only on repeated consistent evidence: four entries match the prior's weight, twelve outweigh it three to one, and someone whose period really runs 7 or 8 days still converges there. A genuinely very long bleed is still not learned from, which is the right trade when the alternative is a silently broken phase model. The exclusion lives in `observedPeriodLengths`, so nothing rewrites or hides what she typed. `classify` deliberately still tests menstrual first: if she is actually bleeding, that is what the day is.

## A log that stops has its own state, and it supersedes reporting menstrual

**Decision.** There is a sixth phase, `stale`. Once the day being reported on is past the far end of the prediction's own 80% interval, `phaseForDate` returns `stale`, `buildPhaseModel` returns no ovulation estimate and no fertile, premenstrual, or menstrual window at all, and `NextStartPrediction.isStale` is true with a summary that says the prediction is out of date instead of naming a past date as what to expect next. This deliberately supersedes the earlier decision to report menstrual for any date at or beyond the predicted start. That decision still holds inside the interval, which is where its reasoning applies.

**Reasoning.** Nothing bounded how stale a log could get. She logs a start, then stops for four months (illness, a pregnancy, a lost phone, or losing interest), and everything stayed anchored to that one start: the app said "Day 127. Period." next to a fertile window from March and a most-likely date months in the past. Those are plainly false statements in an app whose whole thesis is saying only what it can honestly say. Not claiming an overdue period was the right instinct, but the failure it produced past a few days is worse than the one it avoided.

The suppressed fertile window is the part that matters. The likeliest reasons for months of silence are pregnancy, illness, or having given up on the app, and a confidently rendered months-old fertile window is wrong in all three and actively harmful in the first two. So it is removed from the returned model rather than labelled, and no consumer can render one by forgetting to check a flag.

The threshold is the model's own 80% interval and not a day count, because the engine already knows how sure it is: a regular history stops trusting itself about five days past the point estimate, an irregular one holds on for weeks. `stale` is a member of `CyclePhase` rather than a separate boolean so an exhaustive switch over the phases fails to compile until a consumer handles it, which is checked rather than assumed.

**Consequences.** A sixth state the task 2 UI has to render, and it must read differently from the cold start: never having logged and having stopped logging are not the same thing. Resuming is automatic, because the new start becomes the anchor. Historical cycles are untouched, since a completed cycle is bounded by a real next start and never goes stale. The wording names only what the engine knows, never why, because start dates cannot distinguish being late from having missed a log from being pregnant.

## Confidence is scaled against what the model can attain

**Decision.** The reported confidence is the product of two factors, each measured against a limit derived from the model: `maxWeightSum()` for how much data the recency weighting can ever hold, and `minPredictiveSd()` for how tight the priors can ever make the predictive spread.

Both limits depend on the recency half life, so `fitCycleLength` records the half life it used on the posterior and `confidenceFor` takes it as a parameter rather than assuming the default. Freezing the two endpoints at module load looked harmless because `analyze` always uses the default, but `fitCycleLength` and `confidenceFor` are both public, and a fit at a half life of 3 saturates at a weight sum of about 4.85. Scored against the default's 9.17 it could never report more than about half the confidence its data had earned, and nothing in the returned number would have shown it.

**Reasoning.** Both quantities are bounded, and the first version of the scale ignored that. The weight sum saturates near 9.2 and the predictive spread bottoms out near 2.9 days, so the old shaping constants capped the number near 0.63 while advertising a 0.95 ceiling. The top quarter of a 0 to 1 scale was unreachable by construction, which makes the number mean something other than what it says. Deriving the endpoints from the priors means they cannot drift out of step if the priors change.

The ceiling scales that product rather than capping it. Clamping made the top of the scale a plateau: past roughly two and a half years of regular cycles every history reported exactly 0.95 and the number stopped responding to the extra data that earned it, which is the one thing it exists to communicate.

**Consequences.** 0.95 is an asymptote, approached and never quite attained by a real history, and the number moves with every extra cycle and every tighter interval. Two years of cycles varying by about a day reports about 0.87, five years about 0.93, and one or two cycles report under 0.15. `src/engine/__tests__/confidence.test.ts` pins the floor and pins strict monotonicity across nine years of history, so neither the old mismatch nor a new plateau can come back.

## Calibration is replayed, not stored

**Decision.** Reconstruct the full prediction history from the log on every analysis, grading each prediction against what actually happened, using only the data available before that outcome.

**Reasoning.** Storing calibration records alongside the log would create the same drift problem as storing cycles: correct a date and the stored grades become wrong. Replaying also guarantees the reported error and coverage are genuinely out of sample, because each step can only see its own past.

**Consequences.** The reported mean absolute error and coverage are real out-of-sample numbers and can be shown to her without qualification. The replay is O(n squared) in cycles, which at a few hundred cycles is free.

## Related

- [[PLAN]] for what gets built when.
- [[RESEARCH]] for the science and the known limitations.
- [[TESTING]] for how the claims are checked.
