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

| Layer           | File             | What it produces                                                                                                                                          |
| --------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cycle length | `cycleLength.ts` | Normal-Inverse-Gamma posterior over cycle length, recency weighted, giving a Student-t posterior predictive and 50%/80% credible intervals as date ranges |
| 2. Phases       | `phases.ts`      | Menstrual, follicular, fertile, luteal, premenstrual for any date, plus estimated ovulation and fertile window from learned luteal and period lengths     |
| 3. Calibration  | `calibration.ts` | Measured error and coverage from replaying the log, feeding back as an interval widening factor                                                           |

Cold start behaviour is enforced in the engine, not in the UI, so a population baseline can never be presented as a personal prediction:

| Cycles in the fit | Tier       | Behaviour                                                         |
| ----------------- | ---------- | ----------------------------------------------------------------- |
| 0                 | `none`     | Population baseline only, explicitly labelled as not personalized |
| 1 to 2            | `low`      | Predictions with wide intervals and a low confidence value        |
| 3 to 5            | `moderate` | Real predictions, intervals tightening                            |
| 6+                | `high`     | Full confidence reporting                                         |

## Task 2: local storage, logging, and the prediction UI

The first version she can actually use.

- Local-first persistence. IndexedDB or localStorage behind a small repository interface, so storage can be swapped without touching the engine.
- Logging: one button for "my period started today", a date picker for backfilling, and an optional "it ended" entry. Nothing else.
- Editing and deleting entries, because she will typo a date.
- The prediction view: current phase, next period as a range not a date, days until, confidence.
- The confirmation flow for suspected missed logs. The engine already emits the question; the UI has to ask it and act on the answer.
- Clinical notes surfaced somewhere calm, not as an alarm.
- The accuracy view: measured mean absolute error and observed coverage, shown honestly.
- Cold start states rendered from the engine's tier, including the empty state.

Constraint carried forward: the input surface stays at period start, optionally period end. See `CLAUDE.md`.

## Task 3: encrypted backup, PWA shell, and deploy

- End-to-end encrypted backup. Encrypt in the browser with a key derived from a passphrase she controls, so the server only ever holds ciphertext. Export and import as a `*.rageflow.json` file, which is gitignored.
- PWA manifest, icons, service worker, offline support. It has to work on a plane and in a basement.
- Installed-to-home-screen behaviour on iOS: standalone display, safe area insets, no browser chrome.
- Vercel deploy, custom domain, headers.

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
