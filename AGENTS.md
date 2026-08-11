# AGENTS.md

Project-intrinsic guidance for rageflow. Read this before changing anything.

This file is the single source. `CLAUDE.md` at the repo root is a symlink to it, and `docs/CLAUDE.md` is a symlink to `../CLAUDE.md` so the guidance shows up inside the Obsidian vault. Edit `AGENTS.md`, never one of the symlink paths.

## What this is

A menstrual cycle tracker for one person. It is a Next.js PWA, local-first, deployed on Vercel, installed to an iPhone home screen.

## Stack

- Next.js 15 (App Router), TypeScript in strict mode, Tailwind 4
- Vitest for unit tests, ESLint 9 flat config, Prettier
- npm. Not pnpm, not yarn.

## Running and testing

```
npm install
npm run dev          # dev server
npm run build        # production build, also typechecks
npm test             # vitest run, single pass
npm run test:watch   # vitest in watch mode
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier --write
```

`npm run build`, `npm test`, and `npm run lint` must all pass before anything ships.

## The three rules

### 1. Privacy: this repo is public and holds zero health data

No real cycle data. No realistic-looking cycle data. No screenshots containing dates that could be someone's real log. Every fixture in the test suite comes from a seeded synthetic generator in `src/engine/testing/synthetic.ts`, and that is the only place cycle numbers may come from.

`.gitignore` excludes `.env*` and `*.rageflow.json` (the data export format). Do not commit anything matching those, and do not add an exception for them.

### 2. Dates are calendar dates, never instants

Store and compute on local calendar dates as `YYYY-MM-DD` strings. Never a `Date` serialized to UTC. Never an epoch timestamp.

A period start is a fact about a square on a wall calendar. It has no time of day and no time zone. Logging at 11pm and seeing tomorrow's date is the single most obvious way this app can be broken, so the whole engine goes through `src/engine/date.ts`, which does integer day arithmetic and never touches `Date` addition.

The only permitted `new Date()` in the engine is the default argument of `todayLocal()`, which immediately reads local calendar fields. `src/engine/__tests__/purity.test.ts` enforces this.

### 3. The input surface stays tiny

She logs the date her period started. Optionally the date it ended. That is everything.

No symptom logging, no mood logging, no manual temperature, no weight, no notes. The data model in `src/engine/types.ts` is extensible so those could be added later without breaking her history, but they are not built and must not be added speculatively. If a feature needs a new input from her, it is probably the wrong feature.

## Engine boundary

`src/engine/` is pure TypeScript. Zero imports from React, Next, or any browser API. No network, no storage, no `window`, no `document`. It takes a log in and returns an analysis out.

This is enforced two ways: `no-restricted-imports` and `no-restricted-globals` in `eslint.config.mjs`, and `src/engine/__tests__/purity.test.ts`, which scans the source. If you need platform access, it belongs in a layer above the engine.

## Where things live

```
src/engine/          the prediction engine, pure TypeScript
src/engine/testing/  seeded synthetic data generators (test support, never shipped data)
src/app/             Next.js App Router
docs/                the Obsidian vault: plan, research, decisions, testing notes
```

`docs/` is symlinked to `~/obsidian-home/rageflow`, so every markdown file the project produces should live there and be version controlled.

## Writing style

Plain, direct, technically grounded. No marketing language. Use a normal hyphen, never an em-dash or en-dash. If a sentence needs a pause, rewrite it or use a comma, colon, or parentheses.

## Medical framing

The app is not contraception and not medical advice. Fertility output is an estimate inferred from cycle length alone, never an observation. Clinical flags name what was observed and suggest mentioning it to a doctor; they never name a cause or a condition.
