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

**Reasoning.** An end date is one hand-typed self-report, and the first version trusted it about 2.25 to 1 over the population prior, which is the wrong posture for a value tapped in on a phone. Both of its error modes are multi-day: the day she calls the end is genuinely fuzzy, and a mistyped digit moves the date by a week. At the old weighting one 15 day entry pulled the learned length to 11.9, `windowsFor` rounded that to a 12 day menstrual window, and because the bleed is decided before the fertile window the app reported "Period." across the front of its own estimated fertile window, on every cycle in the log. That precedence was a per-day tie-break in a function called `classify` at the time; it is now the layout cut described two decisions down, and it resolves the same way. The bound alone did not fix that, it only moved it below the threshold, so the weighting is the fix and the bound is the backstop for values that are not evidence about her period at all.

Both are about what one entry does to the cycles it says nothing about. What it does to the cycle she logged it on is the next decision, and the two are not in tension: the damping is what keeps the learned parameter doing the job it is for, which is predicting the cycles she has not described.

**Consequences.** Learned period length now moves only on repeated consistent evidence: four entries match the prior's weight, twelve outweigh it three to one, and someone whose period really runs 7 or 8 days still converges there. A genuinely very long bleed is still not learned from, which is the right trade when the alternative is a silently broken phase model. The exclusion lives in `observedPeriodLengths`, so nothing rewrites or hides what she typed. The bleed still wins a day it shares with the fertile window, for the same reason: if she is bleeding, that is what the day is.

## The end date she logged governs the bleed of the cycle she logged it on

**Decision.** `windowsFor` runs the bleed of a cycle to `cycle.endDate` when she recorded one, and only to the learned period length when she did not. The learned length governs the cycles with no logged end, and the bleed the engine expects next, and nothing else.

A logged end that has arrived is taken exactly as typed. The days of it that have already happened are not clamped, not to `MAX_FITTABLE_PERIOD_LENGTH_DAYS` and not to anything else, so a mistyped end date drives its own cycle's drawn window directly: a 22 day entry that has run its course produces a 22 day menstrual window, and the rule that the windows are cut apart in one place then lets that window swallow the fertile window of that cycle. That is accepted deliberately and is not an oversight to be tidied up later. The days of it that have not happened are a different matter and are bounded, two paragraphs down.

The bound on it is today. The window the engine publishes and classifies against runs to the end she typed or to today, whichever comes first. Read cold that looks like the previous paragraph reversed, and it is not: showing a 22 day bleed that already happened is showing her data as it is, while asserting that she is bleeding on days that have not happened is not showing data at all, it is a claim about the future, and a logged fact about the future is not a fact. The entry itself is untouched in both cases: nothing is rewritten, and the day it names becomes a period day the moment it comes round. What the days it names past today are reported as, and how far past today the engine will carry them at all, are the two questions below.

This also puts the logged bleed under the same rule as everything else the engine says. `late` and `stale` stop at today because a model with no credible cycle end has nothing to say about tomorrow, and `predicted-menstrual` exists so that a day the engine expects cannot be reported as one she recorded. The bleed is decided ahead of all three, so before this it was the one output that could reach past today, and it reached there with the most confident wording the engine has.

**The bleed is two values, because it does two jobs.** The first attempt at the bound above was one range clamped at today, and that range also decides where the other windows of the cycle may go. Clamping it fixed what the engine asserts and silently broke the layout: with an end logged for 2024-03-20 and today on the 10th, the fertile window and the ovulation estimate were laid out on the 11th to the 13th, three days inside a span she had recorded as a period, and `phaseForDate` returned `fertile` there with the full estimate wording. The same commit also wrote a test pinning that as correct. So the two jobs are two values, and they are named as such in `CycleWindows`:

- **The recorded bleed span governs layout.** She recorded those days as a period, so nothing else may claim them. `bleedSpan` runs to the end she typed, and the fertile and premenstrual cuts are taken against it. Whether the calendar has caught up with her entry cannot change what her entry says, so the fertility estimate is suppressed over those days on both sides of that line rather than appearing and then vanishing as today advances.
- **The never-past-today rule governs assertion.** The engine must not tell her she is bleeding tomorrow. `menstrual` is `bleedSpan` cut off at today, and it is the only one of the two published or tested against. It is absent altogether in the one case where none of the bleed has happened.

**The span is bounded past today, and only past today.** The two values above were the whole of the rule for one commit, and one mistyped year was enough to show what was missing from it. With a start on 2024-01-29 and an end typed as 2024-12-31, read on 2024-02-10, `phaseForDate` reported `predicted-menstrual` for every day out to 2024-12-31, worded as her bleed running on, and the layout took the same span, so the model published no `fertileWindow`, no `estimatedOvulationDate` and no `premenstrualWindow` for eleven months. Both jobs failed the same way and for the same reason: a bound whose size is whatever she typed is not a bound.

The split is data against projection. A day of her entry that has elapsed is her data and is drawn at whatever length she typed, exactly as before. A day of it that has not is the engine carrying her entry forward across days nobody has lived through, which is a claim about the future like any other and gets bounded like any other. `windowsFor` stops the forward part at `MAX_FITTABLE_PERIOD_LENGTH_DAYS` from the start, or at the day before the next start the engine expects, whichever comes first. The first is the bound the fit already uses, reused rather than reinvented, because how long a period can plausibly run is one question and a second answer to it would drift from the first. The second is there because the days from the predicted start belong to the cycle the engine expects next, and a bleed it has been told nothing about is a bleed of that one.

There is one span, so both jobs get the bound together, and bounding the layout opens a gap. Past the bound the days of an over-long entry stop holding the fertile window back, so a fertility estimate was laid out over days her entry names as a period and then vanished as those days arrived and became facts. That was recorded here for one commit as an accepted cost, on the grounds that any day it can happen on sits inside an entry the fit has already judged not to be a period. Writing it down did not make it acceptable. It is the same estimate over the same recorded days that the two values above exist to prevent, reached from the other side, and the argument for accepting it would have excused the original bug equally well.

**So a cycle whose recorded bleed runs past the plausible bound gets no fertility estimate at all.** Not the window and not the ovulation day, on either side of the day her entry names, because the calendar catching up with an entry cannot turn a cycle the engine could not read into one it can. If the engine cannot say when her period ended it cannot read the structure of that cycle, and the ovulation estimate is read off that structure and off nothing else, so there is no estimate to make. That is the round 4 rule unchanged rather than a patch over the gap: where the engine does not trust its own inputs it withholds fertility instead of guessing, and the failure direction stays suppression rather than over-claiming.

What that costs is bounded, which is what makes it the cheaper of the two. It is one cycle's estimate, not the eleven months of blanked output the bound was introduced to stop: the fertile window belongs to a single cycle, the premenstrual run-up and the ordinary phases are untouched, and the next start she logs opens a cycle the engine can read again. That last clause was false when it was first written here, which is worth recording because it is what a bounded cost was being weighed against. An end matched to a cycle by date alone could only ever land on the last one, so the mistyped entry moved onto each new last cycle as she logged starts and withheld the estimate again on every one of them, indefinitely for someone who logs starts and no ends, which is the whole input surface this app requires. The decision was taken on a cost of one cycle, so the derivation was changed to make that cost real rather than the claim softened: `deriveCycles` places an end on the cycle she wrote it under, and `cycles.test.ts` logs a subsequent start and asserts the estimate comes back. Two alternatives were rejected. Letting the layout use the recorded span out to the predicted start while the assertion stays bounded reopens a gap between the days the layout reserves and the days the assertion claims, which then needs an answer of its own. Leaving it accepted and documented is worse than either, because a decision written down is what tells the next reader there is nothing here to look at.

**Both branches, not one.** The bound applies to a cycle she logged no end for as well. There the span is the learned length, which is an estimate rather than an entry, and if anything less of a licence to say she was bleeding on a day that has not happened: she logs a start today and the app must not report the next four days as a period on the strength of a population average. The first version of the bound was written into the logged-end branch only, so supplying more information made the engine claim less about the near future, which is exactly backwards. `windowsFor` now computes one span and cuts it once, so there is no second branch to forget.

**The days it stops short of are `predicted-menstrual`.** Cutting the assertion at today says what those days are not, and the layout says nothing else may claim them, so the question of what they are reported as is left over and has to be answered. Three answers were available and two of them are wrong:

- Not `menstrual`, which asserts a fact about a day that has not happened. That is the entire point of the bound above.
- Not `follicular` or `luteal`, which contradicts an entry she typed in herself. That is what the code did: with a start on 2024-02-26, an end logged for 2024-03-20 and today on the 10th, `phaseForDate` returned `luteal` for 2024-03-15 with "Day 19. Luteal phase, the second half of the cycle." The layout was holding that day back from every window and the residual follicular and luteal split, which is not a window, took it anyway. This is about the days inside the span, which is the bounded one: past the bound the span holds nothing back and those days take their ordinary phase, with the fertility estimate withheld for the whole cycle as the paragraphs above set out, rather than a return of this bug.
- Not undefined, which puts a hole in a month calendar on a day sitting inside the current cycle and before the predicted start, which is the failure the contiguity rule two sections down exists to prevent.

So `predicted-menstrual`, which already means a bleed day predicted rather than observed and is exactly what these days are. It is not a ninth state: what differs between a day of her bleed running past today and a day of the bleed expected next is where the claim is anchored, not what is being claimed, and a state for a wording difference would be modelling the explanation rather than the thing. That does not conflict with preferring a union member over a flag elsewhere, which exists so a consumer cannot silently mishandle a genuinely different case. These two render the same way.

The wordings differ, because the provenance does. The continuation names the start she logged and says the day has not arrived; the bleed expected next names the date it is indexed to and says nothing is logged for it. Neither asserts that she is bleeding. Alongside them is `PhaseEstimate.predictedBleedBasis`, which is the same distinction as a value rather than as a sentence, because the alternative is a UI matching a regex against prose and failing silently the first time the prose changes. It is a discriminator on the existing state, not a new one.

The bleed is also decided before the state of the log is. `phaseForDate` tests it first, in one place, so the state of the log never decides how a day of the bleed of the cycle she is in is reported. Which of the bleed's two answers a given day gets, and how far each state reaches, is stated in the contract on `phaseForDate` and deliberately not restated here.

**Reasoning.** `cycle.endDate` was collected in `cycles.ts` and read only by `observedPeriodLengths`, so the phase layer never looked at it. The engine held the fact and reported an estimate over the top of it: with a start on 2024-01-01, an end logged on 2024-01-02 and a learned length of 4.4 days, `phaseForDate` returned "Day 3. Period." for 2024-01-03, a day she had explicitly recorded as after the bleed ended.

That is the rule this whole design is stated in, inverted. A logged bleed is a fact and a predicted window is not, and `predicted-menstrual` exists precisely so a day the engine merely expects cannot render as a period she recorded. A day she recorded as not bleeding rendering as one is the same error read backwards.

Not clamping the days that have elapsed follows from the same place. The over-long entry stays in her logged history, excluded from the fit only, never deleted and never silently rewritten, because it is health data she entered and the app does not get to overwrite it. Clamping the drawn window is that same overwriting moved from the data layer to the display layer, so it is rejected on the same ground. The failure direction is safe over those days: a mistyped end that has run its course suppresses fertility output rather than over-claiming it, which is the direction every safety call here has gone. And a 22 day period band shown plainly on screen is itself the signal that the entry is wrong. An implausible entry displayed is self-correcting, because she can see it and fix it; an implausible entry quietly clamped is invisible and stays wrong forever. None of that argument reaches the days it names that have not happened, which is why the bound above stops there and nowhere else.

**Consequences.** The learned period length no longer describes a cycle she has described herself, which is the job it was damped for in the entry above. A cycle with a logged end can have no fertile window and no ovulation estimate, either by the same cut that already handles a short cycle with a long bleed or by the rule above when what she logged runs past the plausible bleed bound, and `PhaseModel` says so. A logged bleed running at or past the predicted start reports `menstrual` rather than `predicted-menstrual` or `late`, since the fact outranks both, once those days have arrived: while they have not, they report `predicted-menstrual` as the bleed the engine expects next, because the projection stops before that start, and they flip to `menstrual` as the calendar reaches them. The length of the bleed the engine predicts is untouched by any of this and stays the learned estimate, which is what `CycleWindows.predictedBleedDays` is named for.

## A start dated after today is not a cycle yet

**Decision.** `deriveCycles` takes `today` and leaves out any period start dated after it, reporting those entries as `futureDatedStarts` on the derivation and on `CycleAnalysis`. The entry stays in the log, visible and unaltered, and starts counting on the day it names. Two other entries get the same treatment, below, and nothing beyond those three is validated.

**Reasoning.** Every date the engine produces is indexed off the last logged start. A start typed with next year's digits, or tapped on a picker that opened on the wrong month, is not a cycle that has happened, and taking it moves the anchor there and drags the prediction, the phases and the calibration replay with it. Excluding it is the same treatment an implausible bleed length already gets in `observedPeriodLengths` and a suspected missed log gets in the skip detection: kept in her history, kept out of the derivation, and reported rather than dropped in silence.

The engine does this itself rather than leaving it to the date picker in task 2. It is the deliverable of task 1 and has to be correct on its own terms, and a component that does not exist yet is not a guard. Task 2 will still validate at the picker, which is where a better message and a chance to correct the entry belong.

**An end date belongs to the cycle she wrote it under, and the order of the log is what says which that is.** The entries are a list she appends to, so the period start entry before an end entry is the cycle that was in progress when she typed it. That is read first, and the date places only the ends the order cannot: one written before any start entry, one written under a start the derivation left out, or one dated before the start it follows, which is a bleed logged after the fact and still hers. For a log written and read in order the two agree, and where they disagree only the order carries the fact that matters, which is when she wrote the entry.

Matched by date alone, an end dated past every start could only ever land on the last cycle, because the last cycle is the only one with no next start to stop the search. Both of the defects that follow are that one sentence read twice. A mistyped year moved onto each new last cycle as she logged starts, so a cycle whose bleed the engine cannot read, and therefore withholds fertility for, was replaced by another one on every start she logged. And an unreadable row anywhere in the log discarded the end of whatever cycle happened to be last, which lays that cycle out around a shorter bleed than the one she recorded and publishes the fertile window across the difference. Discarding an end she logged is not the safe direction, and the safe direction is what the exclusions here are for.

Excluding a start excludes what belongs to it. An end date is matched to the start it follows and bounded by the next one, so leaving a start out of the derivation without keeping the boundary it provided hands its end to the last cycle that was kept. With starts on 2024-01-01 and 2024-01-29, a mistyped 2025-02-26 and its end on 2025-03-01, read on 2024-02-10, the mistyped start was correctly excluded and the 2024-01-29 cycle then took `endDate` 2025-03-01 and a 397 day period, because dropping the trailing start left the last accepted cycle with no `nextStartDate` and so no upper bound on the end search. `deriveCycles` keeps the first excluded start as that bound. A filter that removes one field and leaves its dependents behind is worse than no filter, because the dependents then look like data.

That is a rule about excluded starts and not about future-dated ones, so both exclusions get it. The first version was written for `futureDatedStarts` alone, and the unreadable-start exclusion below then reproduced the same defect the fix had just removed: with starts on 2024-01-01 and 2024-01-29, a start that is not a calendar date and an end on 2024-03-01, the 2024-01-29 cycle took a 33 day bleed it was never told about. Fixing an instance rather than the class is how the same bug arrives twice. An unreadable start has no date to bound with. For the order rule that costs nothing, since where the row sits in the log is exactly what is still readable about it: it closes the cycle before it, so an end written after it is placed on no cycle rather than on one that had already been superseded by the time she typed it. For the date rule nothing says whether it sat before or after the ends that follow the last accepted start, so the boundary is preserved as unknown instead and the last accepted cycle takes no end that way.

That fallback is the whole reach of it, and stating the reach is the point. The first version of this rule claimed the same reach and did not have it: it dropped the end of the last accepted cycle whenever an unreadable row existed anywhere in the log, so a bad entry from months earlier discarded a bleed she had recorded on a cycle it had nothing to do with, and the fertility estimate was published across the days she had typed in. A claim that only one cycle can be affected is cheap to test and was not tested. It is now, and the end itself is untouched in every case, on the same terms as every other entry the derivation cannot place.

**Two more entries the log can contain, on the same terms.**

A **future-dated end** is kept on the cycle and left out of the period-length fit. It was previously recorded here as not needing exclusion, on the grounds that it does not anchor anything and the phase layer declines to read it past today. That was wrong, and it is worth being exact about how: the phase layer's bound is real, but `periodLengthDays` is computed from the logged end with no reference to today, and `observedPeriodLengths` fed anything 15 days or under straight into `learnPeriodLength`. A start on 2024-03-05 read on 2024-03-07 with the end mistyped as 2024-03-15 put an 11 day observation, drawn from three days of actual bleeding, into the parameter that describes every cycle after it. Days that have not happened are not an observation. So `observedPeriodLengths` takes `today` and skips those entries exactly as it skips implausible ones, and the entry itself is untouched: still on the cycle, still laid out around by the phase layer, and counted from the day it names once that day arrives.

An **entry whose date is not a calendar date** is reported as `invalidEntries` rather than thrown. `collectDates` used to throw a `RangeError` on the first bad row, so one corrupt entry in a persisted log or an imported `.rageflow.json` would take down the whole analysis and she would see nothing at all rather than the history that is perfectly readable. That is the opposite posture from every other unusable entry here. Same scope discipline as the rest of this decision: one rule on the existing flag mechanism, no error taxonomy and no validation layer, and the entry is never deleted and never silently rewritten.

**Consequences.** `deriveCycles` now takes `today` as a required argument, so the one thing it needs from the clock is handed to it rather than read, exactly as `analyze` does. `observedPeriodLengths` takes it too, for the same reason. A log made entirely of future dates derives no cycles and reads as an empty log, which is the honest answer. The UI has three lists to show, and can say why a date she can see in her history is not the start of anything.

## The windows are cut apart where they are laid out, not where they are read

**Decision.** `windowsFor` returns windows that cannot overlap, and returns only what the state of the log lets the engine stand behind. The bleed is taken first, then the fertile window with the bleed's days removed, then the premenstrual run-up with both removed. "The bleed" here is the recorded span, not the part of it that has happened; the decision above says why those are two values and which one each job takes. A window with nothing left is absent rather than inverted, so `fertileWindow` and `premenstrualWindow` are optional on `PhaseModel` for that reason as well as for `late` and `stale`. The suppression that `late` and `stale` perform happens there too, so it is one set of windows and not two.

The fertile window and the ovulation estimate are one field internally, present or absent together. On a short enough cycle the bleed covers the ovulation day itself rather than just the front of the window, and what survives the cut is then the tail of a window whose middle the engine says she bled through. An ovulation marker on a day the same engine calls period, and a fertile window with no ovulation left in it, are both the model contradicting itself, so neither is published and `estimatedOvulationDate` is absent whenever `fertileWindow` is.

**Reasoning.** The bleed is indexed forward from the logged start and the fertile window backward from the predicted end, so nothing about the arithmetic keeps them apart. A 22 day history with a logged 7 day bleed fits a 23 day cycle, which puts ovulation on day 11, the fertile window on days 6 to 12, and the bleed on days 1 to 7. Days 6 and 7 sat in both. Short cycles with long bleeds are a real pattern rather than a case invented to break the model.

The collision used to be resolved where a day was looked up, by testing the bleed before the fertile window, which meant `phaseForDate` called those two days period while `buildPhaseModel` handed back a fertile window containing them. One cycle described twice, disagreeing, with the tie-break visible in only one of the two answers. Resolving it in the layout instead means there is no tie to break: the same ranges feed the model and the per-day lookup, so a UI painting the windows and a UI asking day by day give the same answer. The invariant and its domain are stated on `PhaseModel`, which is the one place that spells them out; it holds for every day of the current cycle, which is the only cycle the model describes, and a completed cycle is classified against its own windows between two real starts instead.

The first version of this cut the overlap in the layout but left the state of the log to be applied afterwards, in `buildPhaseModel` alone, which put the disagreement straight back in a place nobody looked. While `late` the model dropped the fertile window and `phaseForDate` went on answering `fertile`, with the full estimate wording, for every day before the predicted start. Suppressing a window on the model and then handing the same days back one calendar cell at a time is the suppression undone, and it is the exact failure the `stale` path had already been fixed for. Doing both cuts in one place is what makes the invariant hold rather than happen to hold: the windows `windowsFor` returns for the current cycle are the only windows that cycle has, in every state.

**Consequences.** No day of a current log changes the phase it is reported as. What changes is that the model stops publishing days it does not itself believe are fertile, and that `phaseForDate` stops reporting days of the current cycle as fertile or premenstrual when the model is withholding those windows. The order the windows are tried in when a day is classified no longer decides anything, which is the point.

## A period that has not arrived and a log that has stopped are both states

**Decision.** Three states beyond the five phases, so `CyclePhase` has eight members.

`predicted-menstrual` is a bleed day that has not happened: a day of the bleed expected next, or a day of the bleed of the cycle she is in that her entry or the learned length reaches past today, which the section above covers. Both belong to a log that is still current, because neither reaches past the start the engine predicted and both of the other states begin there. `late` runs from the predicted start until the staleness bound. It carries the number of days late, keeps the day of cycle, and drops the ovulation estimate and the fertile and premenstrual windows. `stale` takes over past the bound: no predicted windows, no day of cycle, and `NextStartPrediction` becomes a variant with no dates on it at all. The menstrual window survives both, because it is indexed forward from a start she actually logged rather than backward from a predicted end, and `buildPhaseModel` and `phaseForDate` agree about that.

The rule underneath all of that, and the one to reason from when a new case comes up, is that a logged bleed is a fact and a predicted window is not. Facts survive staleness and predictions do not. That is why `menstrualWindow` is the one thing left standing in both states while the ovulation estimate and the fertile and premenstrual windows go, why `phaseForDate` still answers `menstrual` for a date inside a bleed she logged however many months of silence have run since, and why the prediction gives up its dates entirely. An earlier revision of this file stated the design as a rule about which function reports what, which conflated the two: it made the disagreement between `buildPhaseModel` and `phaseForDate` look like an inconsistency to be flattened, when the two were describing a fact and a prediction and were right to treat them differently. This paragraph supersedes that reading.

`predicted-menstrual` is that same rule applied to the one state that had been left out of it. `late` was made to stop claiming the predicted bleed, then `stale` was, and the ordinary current path was still answering a forward-dated query with `phase: 'menstrual'` and `Day 1. Period.`, byte for byte what it returns for a bleed she typed in, for a day that has not happened. A calendar drawn on the 24th asserted a period on five future days and then flipped them to `late` on the 25th. Saying when the period is expected is one of the most useful things this app does and is not what was wrong; claiming it as an observation was. So the claim stays and takes its own member: the phase distinguishes it, and the sentence names the date it is indexed to and says nothing has been logged for it, so a consumer reading either one alone still cannot paint it as a fact. A required flag beside `menstrual` was considered and rejected, on the same ground as `isStale`: a flag can be ignored and a union member cannot.

The bound needs both of two conditions, not either. Today has to be past the 99% quantile of the predictive distribution over the next start, and past two elapsed cycle lengths of silence, counted from the last logged start rather than from periods missed. Both parameters are in `src/engine/constants.ts`.

How far each state reaches per date is stated once, in the doc comment on `phaseForDate`, and this file does not restate it. That comment is the contract; what follows is why it is drawn that way. Three documents each describing an overlapping subset of one rule is how the `late` reach came to be extended by exception three times over, until it claimed the predicted bleed on days that had not happened yet and left a three week hole in a month calendar between that bleed and today.

Both states are read off `today` and never off the date being asked about, so a calendar querying next Tuesday gets next Tuesday's ordinary phase. Neither reaches past today, and both stay contiguous up to it, so a consumer drawing a month gets a run of cells rather than a scatter of them. Stopping at today is the same restraint as withholding the windows: a cycle whose start has not happened cannot place anything after it, and a model with no credible cycle end has nothing to say about tomorrow. That includes the predicted bleed. Once today is `late`, the engine predicted a period and watched nothing arrive, so it must not paint five days of a month calendar as a period its own report on today says did not happen, and it must not report those days at all until they have passed.

The one asymmetry is deliberate. `late` leaves the days before the predicted start with a phase of their own, because nothing has contradicted the cycle they belong to: it ran as predicted right up to the day the period was due. `stale` reports them as `stale` instead. Extending the `stale` treatment to `late` would be wrong, because once a log has been silent for months, the readings for those days were indexed off a predicted cycle end that is now known not to have held, so rendering them confidently would be handing back a falsified prediction one calendar cell at a time.

Whether those days get reported at all and which phase they get are two separate questions, and `late` answers them differently. It keeps the days, and among them it withholds the fertile and premenstrual readings, which come back as the follicular or luteal half the day sits in. That is not the previous rule reversed, it is the same rule at a finer grain: the day is not in doubt, the windows indexed backward from a cycle end that has just failed to arrive are. It is also not a second decision, since those windows are already absent from the model while late, and `phaseForDate` now classifies against the same absent windows rather than against a private copy of them.

The wording follows the same discipline: every day count in a `late` or `stale` summary is measured from the day the sentence describes, so a calendar cell never reports today's count next to its own day number. Only `PhaseEstimate.daysLate` stays measured to today, since being late is a state of the log rather than a property of a day, and it says so.

Underneath that sits the general rule, which is stated where the sentences are defined: **a summary must never assert more than its phase label claims.** The label and the sentence describe the same day and a consumer reads both, so a sentence that reaches further is the engine claiming through the prose what it would not claim through the phase, in the one output no type can constrain. It was reached the way the rest of this file was. `follicular` says which side of the ovulation estimate a day sits on and nothing else, and its sentence said "after the period", which asserts the period is over: past the projection bound a day her own entry names as a period takes its ordinary phase, and so was handed a sentence contradicting the entry it had just been laid out around. The wording a phase is entitled to is whatever that phase already means, which for the halves either side of the estimate is which half they are.

Completed cycles are never `late` or `stale`, since they are bounded by a real next start.

This supersedes the earlier decision to report menstrual for any date at or beyond the predicted start. That reading is now gone entirely: `late` claims only what the engine knows, which is that a date it named has passed with nothing logged, where `menstrual` claimed bleeding it had never observed.

The prediction has three tiers rather than two, cut at boundaries that already exist. Inside the 80% interval it renders in full. Past that interval and before the staleness bound it reframes: the point date is reported as `expectedDate`, in the past tense with a day count, and both intervals are dropped. Past the staleness bound everything goes. `isLate` sits on every variant of the union beside `isStale`, so a consumer reads the state off the prediction instead of pairing it with `PhaseModel.isLate` by convention, and the compiler stops anyone binding `pointDate` to "next period" without handling the other two states. That is checked rather than assumed, with a throwaway consumer compiled against the union: the bad one fails on `pointDate`, on `daysLate`, and on a phase switch that forgets `late`, and the one that handles all three states compiles.

The 80% bound does two different jobs at two different times, and the same number is right for one and wrong for the other. As the trigger for "we know nothing", which is what it used to be, it fires on roughly one normal cycle in ten and blanks the output six days past the point estimate. As the trigger for "this prediction has been outlived" it is exactly right: it is the engine's own statement about where the period would fall, so once today is past the far end of it, every date the prediction carries is in the past and the forward-looking wording has become false. The phase model still turns `late` at the point date and the prediction only at the end of the range, so a late prediction always sits inside a late phase model and the two cannot contradict each other.

**Reasoning.** The first version of this had one state and the wrong threshold. Nothing bounded how stale a log could get, so after four months of silence the app said "Day 127. Period." next to a fertile window from March and a most-likely date months in the past. Anchoring the fix to the far end of the 80% interval then swung it the other way: the engine measures its own 80% coverage at 75-90%, so roughly one normal cycle in ten crosses that bound by running late, and the output went blank six days past the point estimate. Going quiet at the moment its output matters most is the worst thing this app can do, and it is also the moment she is most likely to open it.

So the bound is a far tail plus a floor. The quantile keeps it tied to how sure the fit is, which is the whole reason for having a model: a regular history reaches it sooner than a variable one. The floor keeps a signal about months of silence from being cut from interval width, because two expected cycles with nothing logged is not a late period. In practice a regular 28 day history is `late` for about four weeks, from day 28 to day 56 after the last logged start, and only then `stale`, so eight weeks of total silence is what it takes. A very erratic one holds on past ten.

The suppressed fertile window is the part that matters, in both states. The likeliest reasons for silence are pregnancy, illness, or having given up on the app, and a confidently rendered fertile window is wrong in all three and actively harmful in the first two. It is removed from the returned model rather than labelled, so no consumer can render one by forgetting to check a flag. The same argument applies to the prediction's dates, which is why `NextStartPrediction` is a union discriminated on `isStale` and `isLate` rather than a record of optional dates: a UI binding `prediction.pointDate` to "Next period" now fails to compile instead of rendering a date from March.

All three states are members of `CyclePhase` rather than booleans beside it, so an exhaustive switch fails to compile until a consumer handles them. That is checked rather than assumed, with a throwaway consumer switch compiled against the union: one written before `predicted-menstrual` existed fails on the `never` assignment, and the one that handles all eight compiles.

**Consequences.** Eight states for the task 2 UI to render, and they must read differently from each other and from the cold start: never having logged, being late, and having stopped logging are three different things. Resuming is automatic, because the new start becomes the anchor. `phaseForDate` now returns `predicted-menstrual` through the predicted bleed for a forward-dated query while the log is current and undefined past it, and returns undefined for every date past today once today is late or stale, where before it said "Period." forever. The wording names only what the engine knows, never why: start dates cannot distinguish being late from having missed a log from being pregnant, so the engine reports the day count and stops.

## Confidence is scaled against what the model can attain

**Decision.** The reported confidence is the product of two factors, each measured against a limit derived from the model: `maxWeightSum()` for how much data the recency weighting can ever hold, and `minPredictiveSd()` for how tight the priors can ever make the predictive spread.

Both limits depend on the recency half life, so `fitCycleLength` records the half life it used on the posterior and `confidenceFor` takes it as a parameter rather than assuming the default. Freezing the two endpoints at module load looked harmless because `analyze` always uses the default, but `fitCycleLength` and `confidenceFor` are both public, and a fit at a half life of 3 saturates at a weight sum of about 4.85. Scored against the default's 9.17 it could never report more than about half the confidence its data had earned, and nothing in the returned number would have shown it.

**Reasoning.** Both quantities are bounded, and the first version of the scale ignored that. The weight sum saturates near 9.2 and the predictive spread bottoms out near 2.9 days, so the old shaping constants capped the number near 0.63 while advertising a 0.95 ceiling. The top quarter of a 0 to 1 scale was unreachable by construction, which makes the number mean something other than what it says. Deriving the endpoints from the priors means they cannot drift out of step if the priors change.

The ceiling scales that product rather than capping it. Clamping made the top of the scale a plateau: past roughly two and a half years of regular cycles every history reported exactly 0.95 and the number stopped responding to the extra data that earned it, which is the one thing it exists to communicate.

The bottom of the scale had the same shape of problem in reverse. The precision factor ran down a straight line to exactly zero at a predictive spread of ten days, and a factor of zero makes the whole number zero, so years of genuinely erratic cycles reported precisely what a log with nothing in it reports. Those are different states and the number has to keep them apart. Under the ramp now sits a geometric tail worth `CONFIDENCE_PRECISION_TAIL` at the ceiling that keeps decaying past it without arriving, so zero is left to mean one thing: no data. The tail only bites where the ramp has all but run out, so every fit worth reporting on reads exactly as it did.

The wording had to move too. The tier is driven by volume alone, which is deliberate, but volume alone does not make a prediction trustworthy: a long history of erratic cycles reported `high` confidence tier, a confidence near zero, and a sentence saying there was enough history to report confidence properly. All three at once reads as a contradiction. The top tier now splits on the predictive spread and says there is plenty of history and that her cycles vary enough that the range stays wide. Wide is measured against the untouched population prior's own predictive spread rather than a tuned threshold, so it means something exact: all that history has bought no more precision than the baseline everyone starts from.

**Consequences.** 0.95 is an asymptote, approached and never quite attained by a real history, and the number moves with every extra cycle and every tighter interval. Two years of cycles varying by about a day reports about 0.87, five years about 0.93, and one or two cycles report under 0.15. Zero is now reachable only with nothing to fit. `src/engine/__tests__/confidence.test.ts` pins both ends and pins strict monotonicity across nine years of history, so neither the old mismatch, nor a new plateau, nor a collapse to zero can come back.

## Calibration is replayed, not stored

**Decision.** Reconstruct the full prediction history from the log on every analysis, grading each prediction against what actually happened, using only the data available before that outcome.

**Reasoning.** Storing calibration records alongside the log would create the same drift problem as storing cycles: correct a date and the stored grades become wrong. Replaying also guarantees the reported error and coverage are genuinely out of sample, because each step can only see its own past.

**Consequences.** The reported mean absolute error and coverage are real out-of-sample numbers and can be shown to her without qualification. The replay is O(n squared) in cycles, which at a few hundred cycles is free.

## The database is versioned from the first release

**Decision.** `src/storage/schema.ts` holds `MIGRATIONS`, an append-only array where index `i` upgrades a database at version `i` to `i + 1`, and `DB_VERSION` is derived from its length. It shipped with one rung in it.

**Reasoning.** A ladder with one rung does nothing that `createObjectStore` in an `onupgradeneeded` handler would not do, so on the day it was written it was pure ceremony. The day it stops being ceremony is the day the shape has to change, and on that day the database already holds the only copy of her history. There is no server to rebuild from and no second device to diff against. Retrofitting a migration mechanism onto live data is a different job from having one, and it is a job done under the pressure of not being allowed to get it wrong.

Deriving `DB_VERSION` from the array length rather than declaring it separately removes the one mistake this design invites: bumping the version and forgetting the rung, or writing the rung and forgetting the version. Neither is possible when there is one number and it is computed.

**Consequences.** Adding a rung is appending a function. The rules that make that safe, never edit, reorder or renumber an existing entry, are stated at the top of the file, because a database in the wild has already run the old code and will only ever run the rungs above where it stopped.

## Import merges rather than replaces

**Decision.** Restoring from a backup file adds every entry the log does not already have, keyed on the day and what was logged about it, and changes nothing that is already there. There is no replace.

**Reasoning.** "Restore" usually means replace, and replace is the only operation in this app that can destroy data. She picks a backup from three months ago, and everything logged since is gone, with no undo and no other copy anywhere. A confirmation dialog with a count in it does not fix that; it just makes the loss consented to.

Merging cannot lose an entry. What it can do is bring back one she deliberately deleted, and that is recoverable on the Log screen in two taps. Given a choice of failure modes, the recoverable one wins.

The compound key `[date, kind]` is what makes this exact rather than approximate. An entry is one fact about one day, so importing the same file twice is a no-op, and there is no merge conflict to resolve because two entries that agree on the day and the kind are the same entry.

**Consequences.** The export and import round trip is closed: export, wipe, import, and the engine reads the restored log identically. That is asserted in `src/storage/__tests__/backup.test.ts` against a seeded synthetic history, not just against a hand-written pair of dates.

## Editing a date refuses rather than overwrites

**Decision.** `move` in `src/storage/repository.ts` reads the destination key in the same transaction that would do the write. If `[to, kind]` is already taken it writes nothing at all, leaves the source where it is, and throws a sentence naming what is in the way: "That date already has a period start. Delete one of them first." If `[from, kind]` holds nothing it is a no-op rather than a write that invents an entry at the destination.

**Reasoning.** This is the same decision as import merging rather than replacing, applied to the other path that can destroy data. A correction is one date field and a Save button, so the collision is not exotic: she logs a start on the wrong day, logs it again correctly, then goes back to fix the first one onto the day she already has. An overwrite there silently collapses two logged starts into one and takes the destination's `meta` with it, which is exactly the thing `merge` and the unrecognised-kind rule exist to prevent an older build from doing.

Refusing costs her one delete. Overwriting costs her a period start she logged, with no undo and no second copy, and the cycle either side of it changes length without her having typed anything. Given a choice of failure modes, the recoverable one wins, and the recoverable one here is refusal.

The message is thrown rather than returned because that is what the layers above already carry: the Log screen's edit row catches it, shows it under the date field, and leaves the row open with her date still in it, so the correction is one more tap rather than a retype.

**Consequences.** `moveEntry` in the store is the second action whose failure the caller reports, so it does not also set the shared `actionError` and reappear on another screen. Three cases are asserted in `src/storage/__tests__/repository.test.ts`, and two of them assert the log is byte-identical afterwards rather than only that it threw, because a refusal that half wrote is worse than the overwrite it replaced.

## An entry kind this build does not understand is kept

**Decision.** The parser accepts any entry with a string `date` and a string `kind`, stores it, and shows it in the log list. It does not check `kind` against the two this version knows.

**Reasoning.** The data model exists so a later version can add an entry kind without a migration, and `deriveCycles` skips a kind it does not recognise rather than failing on it. So the only thing validating `kind` here would achieve is this build deleting data a later build wrote, on a downgrade or a restore from a newer phone. `meta` is carried across whole for the same reason.

**Consequences.** An unrecognised kind appears in the log list under its own raw name. That is deliberate: a row she cannot see is a row she cannot delete.

## Today is state, and it is re-read

**Decision.** The log store holds today in React state, sets it on mount rather than during render, and re-reads it on `visibilitychange`, on `focus`, and on a 30 second timer.

**Reasoning.** This app is installed to a home screen and left open for days. Capture today once at load and the button that logs "my period started today" writes yesterday's date after midnight, which is the exact failure the whole calendar-date design exists to prevent, reintroduced at the last layer. Setting it on mount rather than during render also keeps it out of the server render, where the host has no idea what day it is where she is.

**Consequences.** Every screen re-renders when the day turns over, which is correct: the day of cycle, the days until, and the late state are all functions of today.

## Related

- [[PLAN]] for what gets built when.
- [[RESEARCH]] for the science and the known limitations.
- [[TESTING]] for how the claims are checked.
