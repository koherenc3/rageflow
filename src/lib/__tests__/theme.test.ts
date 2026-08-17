/**
 * Two things about `globals.css` that nothing else can catch.
 *
 * Neither of these breaks a build, fails a type check, or shows up in a unit
 * test of a component. Both of them render as a broken app.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { phaseDisplay } from '../display';
import type { CyclePhase } from '@/engine/types';

const CSS = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');

const ALL_PHASES: readonly CyclePhase[] = [
  'menstrual',
  'predicted-menstrual',
  'follicular',
  'fertile',
  'luteal',
  'premenstrual',
  'late',
  'stale',
];

describe('globals.css', () => {
  it('names its source root instead of relying on automatic detection', () => {
    // Tailwind v4 finds sources automatically and where it starts depends on the
    // shape of the checkout. On Vercel it reached `src/app` and nothing else,
    // so every class used only in `src/components` was missing from the
    // deployed stylesheet and the live site rendered as unstyled HTML. The
    // local build was complete the whole time, which is why this is pinned here
    // rather than trusted to a screenshot.
    expect(CSS).toMatch(/@source\s+["']\.\.\/["']/);
  });

  it('defines both colours of every phase tone, in both schemes', () => {
    // A tone with no variable renders as an unset custom property, which is a
    // transparent card with invisible text rather than an error.
    for (const phase of ALL_PHASES) {
      const { tone } = phaseDisplay(phase);
      for (const suffix of ['', '-soft']) {
        const declarations = CSS.match(
          new RegExp(`--phase-${tone}${suffix}:\\s*#[0-9a-f]{3,8}`, 'gi')
        );
        // Once for the light palette, once for the dark one.
        expect(declarations?.length, `--phase-${tone}${suffix}`).toBe(2);
      }
    }
  });

  it('defines every dark-scheme token it defines in the light one', () => {
    // A token declared only in the dark block is unset in daylight, which is
    // the failure that only shows up on someone else's phone.
    const blocks = CSS.split('@media (prefers-color-scheme: dark)');
    const light = blocks[0] ?? '';
    const dark = blocks[1] ?? '';
    expect(dark).not.toBe('');

    const names = (source: string) =>
      new Set((source.match(/--[a-z0-9-]+(?=:\s*#)/gi) ?? []).map((name) => name.toLowerCase()));

    const missing = [...names(dark)].filter((name) => !names(light).has(name));
    expect(missing).toEqual([]);
  });
});
