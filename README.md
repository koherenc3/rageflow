# rageflow

A menstrual cycle tracker built for one person.

Log the day your period starts. That is the entire input. From those dates alone the app learns your cycle, tells you what phase you are in, and predicts when your next period is likely, with an honest range rather than a single confident date. It gets more accurate the longer you use it.

**This is not contraception, and it is not medical advice.** Ovulation and the fertile window are inferred from cycle length alone. They are estimates, not observations. Do not use this app to avoid or achieve pregnancy, and talk to a doctor about anything that concerns you.

## What it does

- **Learns your cycle length.** A Bayesian model over your observed cycles, weighted towards recent ones so it tracks real change instead of averaging over years of stale history.
- **Predicts with a range.** Every prediction comes with a 50% and an 80% range, never a bare date. When there is little data the range is wide, and it tightens as cycles accumulate. That is a property of the maths, not a design choice applied afterwards.
- **Notices missed logs.** A gap that looks like two cycles recorded as one gets flagged and left out of the model rather than quietly wrecking the estimate.
- **Grades itself.** It tracks how accurate its own past predictions were and widens its ranges when it has been over-confident. You can see the numbers.
- **Says when it does not know.** With no history it says so plainly instead of dressing up a population average as a personal prediction.

## What it does not do

No symptom logging. No mood logging. No temperature. No accounts, no sharing, no analytics, no notifications shaming you into opening it. Three screens, and one of them is a button.

## Privacy

Your data lives on your device, in its browser storage, and nowhere else. There is no server-side database of anything you log, no account, no third-party script, and nothing is ever sent anywhere. Backup is a file you save yourself.

Encrypted cloud backup is the next piece of work. Until it lands, the file is the backup, so save one.

This repository is public and contains no health data of any kind. Every number in the test suite comes from a seeded synthetic generator.

## Status

Usable. Local storage, the three screens, export and import, and the installable PWA are done and deployed. Encrypted cloud backup is the remaining piece. See [docs/PLAN.md](docs/PLAN.md).

## Stack

Next.js (App Router), TypeScript in strict mode, Tailwind, Vitest. Deployed on Vercel as an installable PWA.

The prediction engine at `src/engine/` is pure TypeScript with no React, Next, or browser dependencies, so it can be tested in a plain node process and moved somewhere else later.

## Running it

```
npm install
npm run dev      # http://localhost:3000
npm run build
npm test
npm run lint
npm run icons    # regenerate the app icons from scripts/generate-icons.mjs
```

The service worker only registers in a production build, so check anything offline with `npm run build && npm start` rather than the dev server.

## Documentation

`docs/` is an Obsidian vault, version controlled with the code.

- [PLAN.md](docs/PLAN.md) - the phased build plan
- [RESEARCH.md](docs/RESEARCH.md) - the cycle science the model is built on, with sources
- [DECISIONS.md](docs/DECISIONS.md) - architectural decisions and the reasoning behind them
- [TESTING.md](docs/TESTING.md) - how to run the tests, what the fixtures are, what is actually proven

## Licence

Not currently licensed for reuse.
