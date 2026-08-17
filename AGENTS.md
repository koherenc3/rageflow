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
npm run icons        # regenerate public/icons from scripts/generate-icons.mjs
```

`npm run build`, `npm test`, and `npm run lint` must all pass before anything ships.

## The three rules

### 1. Privacy: this repo is public and holds zero health data

No real cycle data. No realistic-looking cycle data. No screenshots containing dates that could be someone's real log. Ever, anywhere.

Every generated cycle history and every statistical fixture comes from the seeded synthetic generator in `src/engine/testing/synthetic.ts`, and that is the only place those numbers may come from. Hand-written literal dates are allowed in deterministic unit tests, where the point is arithmetic you can check by hand, and they must stay obviously synthetic: `2024-01-01` plus exact 28 day steps, not a plausible log. See `docs/TESTING.md`.

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

## The UI shows what the engine claims, and nothing more

The engine distinguishes what she logged from what it inferred, and it withholds anything it cannot support. The UI's job is to carry that distinction to the screen, not to flatten it into a tidier layout.

In practice:

- Where the engine returns no fertile window, no interval, or a `NaN`, render nothing. Never a dash, never a zero, never a substituted estimate. `Stat` and the `format*` helpers in `src/lib/display.ts` return `undefined` for exactly this reason.
- A `predicted-menstrual` day must never look like a `menstrual` one. `phaseDisplay` carries `isEstimate` so the marker cannot be forgotten.
- The prediction is a discriminated union with four states, and each gets its own block rather than one block with fields blanked out. `NextPeriodCard` takes `CurrentNextStartPrediction | LateNextStartPrediction`, so the compiler stops anyone rendering a range for a state that has none.
- The headline for the next period is the 80% range. The point date appears under it, named as the most likely day.
- Engine sentences are shown as written. `humanizeDates` respells the dates in them and moves no other word; it is a substitution over `YYYY-MM-DD`, not a paraphrase.

The same restraint applies to what the app claims about itself:

- Say what happened, never what you hope happened. The export hands the file to the browser and says the backup is ready, not that it was saved, because on iOS the click opens a share sheet she can cancel and nothing tells the app either way.
- A failure belongs to where and when it happened. `actionError` is dropped when the route changes, so a message never follows her to a screen where she did nothing, and it is never still waiting when she comes back.
- A note that reports a failed action passes `alert` to `Note`, which sets `role="alert"`. A refused save moves no focus and changes nothing audible, so with VoiceOver on an unannounced failure reads as a success. Everything the engine merely observes stays quiet.

## Storage

`src/storage/` is the only thing that reads or writes her history. IndexedDB via `idb`, one connection per page.

`MIGRATIONS` in `src/storage/schema.ts` is an append-only ladder and `DB_VERSION` is derived from its length. Never edit, reorder, or renumber an existing rung: a database in the wild has already run it. This is the only copy of her data, so the mechanism is there from version 1 rather than retrofitted.

Import merges, it does not replace. Replacing is what "restore" usually means and it is also the only operation that can destroy data. Merging can bring back a deleted entry, which is two taps to fix; replacing with a stale file loses everything since, which is not fixable.

Nothing here silently overwrites something she logged, and that rule is not only about import. `move` refuses when the destination day already holds an entry of that kind: it writes nothing, and throws a sentence the Log screen shows next to the row she was editing, so the fix is her deleting one of the two. Deleting is explicit and confirmed; an overwrite would be neither. Any future write path takes the same rule.

An entry kind this build does not understand is stored and shown, never dropped. The data model exists so a later version can add one without a migration, and the engine skips a kind it does not recognise rather than failing on it.

## Styling

`src/app/globals.css` is the whole stylesheet: the palette, the phase tones, and the handful of element rules Tailwind utilities cannot express.

`@source "../"` at the top of it names the scan root. Do not remove it. Tailwind 4 detects sources automatically and where it starts depends on the shape of the checkout: locally it reached all of `src`, on Vercel it reached `src/app` alone, so every class used only in `src/components` was missing from the deployed stylesheet while the build, the types, the tests and the local screenshots were all fine.

Every phase tone needs both a `--phase-<tone>` and a `--phase-<tone>-soft`, in the light block and in the dark one, or the card renders transparent with invisible text. A token defined only in the dark block is unset in daylight. `src/lib/__tests__/theme.test.ts` reads the file and pins all three of these, because none of them breaks a build.

Leave `input[type='date']::-webkit-calendar-picker-indicator` where the browser puts it. Stretching it across the field to widen the tap target lays it over the month, day and year segments and swallows the clicks that select them, so the date cannot be typed at all. The only override on it is the dark-scheme filter, which changes its colour and not its box.

## Where things live

```
src/engine/          the prediction engine, pure TypeScript
src/engine/testing/  seeded synthetic data generators (test support, never shipped data)
src/storage/         IndexedDB repository, schema ladder, backup file format
src/lib/             the log store (React context) and pure display helpers
src/components/      the three screens and the pieces they are built from
src/app/             Next.js App Router: routes, layout, manifest
scripts/             icon generator, run with `npm run icons`
public/              generated icons and the service worker
docs/                the Obsidian vault: plan, research, decisions, testing notes
```

`docs/` is symlinked to `~/obsidian-home/rageflow`, so every markdown file the project produces should live there and be version controlled.

## Deploying

Vercel, Hobby tier, `$0/month`. Live at https://rageflow.vercel.app.

Pass `--scope melandod-2824s-projects` on every `vercel` command. Never link or deploy this project to any other scope.

**After a deploy that touched anything visual, check the deployed stylesheet, not just the page.** Vercel's build cache will happily reuse the previous CSS across a deploy, so a fix to it can go out and change nothing:

```
CSS=$(curl -s https://rageflow.vercel.app/ | grep -oE '/_next/static/css/[a-z0-9]*\.css' | head -1)
curl -s "https://rageflow.vercel.app$CSS" | wc -c    # must match .next/static/css/*.css
```

If it does not match, redeploy with `--force`. This happened once and the live site served unstyled HTML while every local check passed.

## Verifying in a browser

Build and serve the production bundle before checking anything visual: the service worker only registers in production, and the dev server does not exercise it.

**Do not run `next build` while `next start` is serving the same `.next`.** It completes without an error and leaves a stale CSS file behind, so newly added Tailwind classes silently do not exist. It cost an hour once. Stop the server first, or `rm -rf .next` if a class you can see in the source has no effect in the browser.

Headless Chrome will not focus the shadow segments of `<input type="date">`, so a date field cannot be driven by clicking and typing. Set the value the way React detects a real edit: the native `HTMLInputElement.prototype.value` setter, then a bubbling `input` event.

## Writing style

Plain, direct, technically grounded. No marketing language. Use a normal hyphen, never an em-dash or en-dash. If a sentence needs a pause, rewrite it or use a comma, colon, or parentheses.

## Medical framing

The app is not contraception and not medical advice. Fertility output is an estimate inferred from cycle length alone, never an observation. Clinical flags name what was observed and suggest mentioning it to a doctor; they never name a cause or a condition.
