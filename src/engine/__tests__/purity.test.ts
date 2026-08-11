/**
 * The engine's portability guarantee, asserted rather than assumed.
 *
 * src/engine must be plain TypeScript: no React, no Next, no browser APIs, no
 * network, no storage. The lint config enforces it while you type; this test
 * enforces it in CI, and would catch a rule being disabled.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENGINE_ROOT = join(process.cwd(), 'src', 'engine');

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const files = sourceFiles(ENGINE_ROOT);

/**
 * Comments and user-facing strings discuss the things this test bans, which is
 * the point of them. Only executable code is scanned. Import specifiers are
 * pulled out before string contents are stripped.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'))
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe('engine purity', () => {
  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('imports nothing outside the engine', () => {
    const importPattern = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+'([^']+)'/g;
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] as string;
        expect(
          specifier.startsWith('.'),
          `${relative(process.cwd(), file)} imports ${specifier}; the engine must only import from itself`
        ).toBe(true);
      }
    }
  });

  it('uses no dynamic imports or requires', () => {
    for (const file of files) {
      const source = code(file);
      expect(source).not.toMatch(/\brequire\s*\(/);
      expect(source).not.toMatch(/\bimport\s*\(/);
    }
  });

  it('touches no browser or platform global', () => {
    const forbidden = [
      'window',
      'document',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'navigator',
      'fetch',
      'XMLHttpRequest',
      'crypto',
      'process',
      'globalThis',
    ];
    for (const file of files) {
      const source = code(file);
      for (const name of forbidden) {
        expect(source, `${relative(process.cwd(), file)} references ${name}`).not.toMatch(
          new RegExp(`(?<![\\w.'"\`])${name}\\b`)
        );
      }
    }
  });

  it('constructs a Date in exactly one place, and only to read local fields', () => {
    const users = files.filter((file) => /\bnew Date\b/.test(code(file)));
    expect(users.map((file) => relative(ENGINE_ROOT, file))).toEqual(['date.ts']);
    // And only as the default argument of todayLocal, which immediately
    // converts to a calendar string.
    const source = stripComments(readFileSync(join(ENGINE_ROOT, 'date.ts'), 'utf8'));
    expect(source.match(/new Date\(\)/g)).toHaveLength(1);
    expect(source).toContain('todayLocal(now: Date = new Date())');
  });

  it('never serialises a date through UTC', () => {
    for (const file of files) {
      const source = code(file);
      expect(source).not.toMatch(/toISOString|getUTC|setUTC|Date\.UTC|getTime\(\)|Date\.parse/);
    }
  });
});
