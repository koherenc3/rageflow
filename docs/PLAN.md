# Plan

Phased build. Each task ends with `npm run build`, `npm test`, and `npm run lint` passing clean, and is shipped as one PR.

## Task 1: foundation and the prediction engine (this task)

Done.

- Next.js App Router, TypeScript strict, Tailwind, Vitest, ESLint, Prettier. npm.
- A placeholder page that proves the app builds and runs. No product UI.
- This docs vault, with `docs/CLAUDE.md` symlinked to the root `CLAUDE.md`.
- The complete adaptive prediction engine at `src/engine/`, pure TypeScript with zero React, Next, or browser imports, enforced by lint rules and by a test that scans the source.
- The test suite, including the synthetic fixtures and the two headline property assertions. See [[TESTING]].

What the engine does, in three layers:

| Layer           | File             | What it produces                                                                                                                                                                                               |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cycle length | `cycleLength.ts` | Normal-Inverse-Gamma posterior over cycle length, recency weighted, giving a Student-t posterior predictive and 50%/80% credible intervals as date ranges                                                      |
| 2. Phases       | `phases.ts`      | Menstrual, follicular, fertile, luteal, premenstrual for any date, plus the `predicted-menstrual`, `late` and `stale` states, estimated ovulation, and a fertile window from learned luteal and period lengths |
| 3. Calibration  | `calibration.ts` | Measured error and coverage from replaying the log, feeding back as an interval widening factor                                                                                                                |

Cold start behaviour is enforced in the engine, not in the UI, so a population baseline can never be presented as a personal prediction:

| Cycles in the fit | Tier       | Behaviour                                                         |
| ----------------- | ---------- | ----------------------------------------------------------------- |
| 0                 | `none`     | Population baseline only, explicitly labelled as not personalized |
| 1 to 2            | `low`      | Predictions with wide intervals and a low confidence value        |
| 3 to 5            | `moderate` | Real predictions, intervals tightening                            |
| 6+                | `high`     | Full confidence reporting                                         |

The original spec had five phases and that was wrong three times over, so there are eight. A period that has not arrived and a log that has stopped are both states the app has to be able to report, neither is a phase of a cycle, and a day of the bleed the engine merely expects is not the same claim as a day of one she logged:

| State                 | When                                                                                                  | What the engine does                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `predicted-menstrual` | A bleed day that has not happened: the bleed expected next, or the bleed she is in running past today | Names the start the day is counted from and says it has not arrived, worded so it cannot read as a logged one, with `predictedBleedBasis` carrying which of the two it is |
| `late`                | Today is on or past the predicted start, nothing logged                                               | Reports the days late, keeps the day of cycle, drops the ovulation estimate and the fertile and premenstrual windows of the current cycle everywhere they would show      |
| `stale`               | Today is past both the 99% predictive quantile and two elapsed cycle lengths of silence               | Reports no cycle at all, drops every predicted window, and `prediction` hands back no dates                                                                               |

`late` and `stale` are read off today, never off a date being asked about, so a month calendar querying next Tuesday is not evidence that anything has stopped. Neither reaches past today, and both stay contiguous up to it, so a month renders as a run of cells and then blanks rather than a scatter. Neither will claim the bleed the engine predicted and then watched not arrive. The bleed she logged survives both, since it is a fact rather than a prediction, and that one rule is what the whole staleness design is stated in: it is also why the bleed still ahead of her is its own state rather than `menstrual`, and why that window ends where she logged the period ending rather than where the learned length would have put it, and stops at today when the end she typed is later than today. A start dated after today is not a cycle at all: it stays in her log and is reported as one the engine has not counted yet. Stopping is also a different state from never having started, and the two read differently. What each state reaches per date is spelled out once, in the doc comment on `phaseForDate`, which is the contract; see [[DECISIONS]] for why it is drawn that way.

## Task 2: storage, the screens, the PWA, and deploy

Done. Live at https://rageflow.vercel.app, installable to an iPhone home screen.

The first version she can actually use.

- Local-first persistence. IndexedDB behind `LogRepository` in `src/storage/`, so storage can be swapped without touching the engine. Versioned from the start: `MIGRATIONS` is an append-only ladder and `DB_VERSION` is derived from its length, because this database holds the only copy of her history and retrofitting a migration mechanism onto it later is not a thing anyone should have to do. `navigator.storage.persist()` is asked once on first run, and the answer is reported rather than assumed.
- Export and import as a `*.rageflow.json` file, which is gitignored. Her only backup in this version, so the headline test takes a log out through the writer and back in through the parser and the repository, and asserts the engine reads the restored log identically.

  Import merges rather than replaces. That is the decision worth remembering: replacing is the usual meaning of "restore" and it is also the only operation here that can destroy data, since a backup from three months ago would take everything since with it. Merging cannot lose an entry. What it can do is bring back one she deleted, which is two taps to undo.

- Logging: one button for "my period started today", a date field for backfilling, and an optional "it ended" entry. Nothing else.
- Editing and deleting entries, because she will typo a date. Delete is quiet until it is armed, then confirms.
- Three screens. Today, Log, History, on a bottom tab bar. The prediction view leads with the 80% range rather than a date, with the point date under it named as the most likely day, and it renders `late` and `stale` as their own states rather than as phases. `NextPeriodCard` takes a type that excludes the stale variant, so the compiler stops anyone rendering a range for a state that has none.
- `futureDatedStarts` and `invalidEntries` are shown in the engine's own words, on Today as well as on Log, so a date she can see in her log always has an explanation for why it counted for nothing. The date fields cap at today, so a future-dated start is hard to type in the first place.
- Missed log suspicions are asked on the Log screen, next to the field that answers them. The engine emits the question and the UI asks it; nothing writes a start she did not type.
- Clinical notes on the History screen, calm, in the engine's non-diagnosing words.
- The accuracy view: measured error and observed coverage, shown honestly, and absent entirely until there is something measured. `NaN` renders as nothing, never as `0%`.
- Cold start states from the engine's tier. The empty state is one card rather than two, and shows no dates at all: with nothing logged the model counts forward from today, which is a day she did not choose, so a range there would read as a prediction about her.
- PWA: manifest, generated icons, service worker, offline shell. Cache-first for content-hashed assets, network-first for everything else, so a cached page can never ask for a chunk a later deploy has deleted.
- Vercel deploy, Hobby tier.

Constraint carried forward: the input surface stays at period start, optionally period end. See `CLAUDE.md`.

## Task 3: encrypted cloud backup

- End-to-end encrypted backup. Encrypt in the browser with a key derived from a passphrase she controls, so the server only ever holds ciphertext.
- The local file export built in task 2 stays. It is the thing that works with no network and no account, and cloud backup is an addition to it rather than a replacement.
- A custom domain, if one is wanted.

## Deferred

Not in scope, not started, and each needs a reason to exist before it gets built.

- **Push notifications.** iOS web push works but is fiddly, and the app is useful without it.
- **Optional symptom tracking.** The data model in `src/engine/types.ts` allows new entry kinds without a migration, so this stays cheap to add. It is deferred because every added input is a reason not to open the app.
- **LH, cervical mucus, and BBT inputs.** These are the only things that would sharpen the luteal length parameter and turn ovulation from an inference into an observation. The update hook is already built (`learnLutealLength`). See [[RESEARCH]] for why it matters and what it would buy.
- **Multi-user.** There is one user. Adding accounts would mean adding a server, which would mean the health data stops being local-first.

## Related

- [[RESEARCH]] for the science behind the model.
- [[DECISIONS]] for the architectural choices.
- [[TESTING]] for the test suite and fixtures.
