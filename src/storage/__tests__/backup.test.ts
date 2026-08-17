/**
 * Export and import.
 *
 * This file is her only backup in this version, so the headline test is the one
 * that takes a log out through the writer, back in through the parser and the
 * repository, and asserts the engine reads the restored log identically. A
 * backup that restores to something the engine analyses differently is not a
 * backup.
 *
 * The multi-cycle history here comes from the seeded synthetic generator, which
 * is the only permitted source of anything cycle-shaped. See docs/TESTING.md.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { analyze, logFromStartDates } from '@/engine';
import { generateCycleLengths, startDatesFromLengths } from '@/engine/testing/synthetic';
import { DB_NAME } from '../schema';
import { closeAll, freshRepository, repository, withCleanDatabase } from './support';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupParseError,
  backupFileName,
  buildBackup,
  parseBackup,
  serializeBackup,
} from '../backup';
import type { CycleLog } from '@/engine/types';
import type { ISODate } from '@/engine/date';

const EXPORTED_ON = '2024-06-01';

/**
 * `count` period start dates from the seeded generator.
 *
 * The generator produces lengths; `n` lengths make `n + 1` starts. Nothing
 * cycle-shaped in this file comes from anywhere else.
 */
function syntheticStarts(seed: number, count: number): ISODate[] {
  return startDatesFromLengths(
    '2023-01-01',
    generateCycleLengths({ count: count - 1, meanDays: 28, sdDays: 2, seed })
  );
}

withCleanDatabase();

describe('serializeBackup', () => {
  it('wraps the log in an envelope naming what wrote it', () => {
    const backup = buildBackup({ version: 1, entries: [] }, EXPORTED_ON);
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.exportedOn).toBe(EXPORTED_ON);
  });

  it('carries a calendar date and nothing resembling a timestamp', () => {
    const text = serializeBackup({ version: 1, entries: [] }, EXPORTED_ON);
    expect(text).toContain('"exportedOn": "2024-06-01"');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('copies entries rather than aliasing the log it was handed', () => {
    const log: CycleLog = { version: 1, entries: [{ date: '2024-01-01', kind: 'period-start' }] };
    const backup = buildBackup(log, EXPORTED_ON);
    expect(backup.log.entries[0]).not.toBe(log.entries[0]);
    expect(backup.log.entries[0]).toEqual(log.entries[0]);
  });

  it('names the file with the suffix .gitignore keys on', () => {
    expect(backupFileName(EXPORTED_ON)).toBe('rageflow-2024-06-01.rageflow.json');
    expect(backupFileName(EXPORTED_ON).endsWith('.rageflow.json')).toBe(true);
  });
});

describe('parseBackup', () => {
  it('refuses a file that is not JSON', () => {
    expect(() => parseBackup('not json at all')).toThrow(BackupParseError);
  });

  it('refuses a JSON file that was written by something else', () => {
    expect(() => parseBackup(JSON.stringify({ format: 'some-other-app', log: {} }))).toThrow(
      BackupParseError
    );
  });

  it('refuses a backup from a newer format version rather than guessing at it', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION + 1,
      exportedOn: EXPORTED_ON,
      log: { version: 1, entries: [] },
    });
    expect(() => parseBackup(text)).toThrow(/newer version/);
  });

  it('refuses a backup with no entries array', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      formatVersion: 1,
      exportedOn: EXPORTED_ON,
      log: { version: 1 },
    });
    expect(() => parseBackup(text)).toThrow(BackupParseError);
  });

  it('keeps the rows it can read and counts the ones it cannot', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      formatVersion: 1,
      exportedOn: EXPORTED_ON,
      log: {
        version: 1,
        entries: [
          { date: '2024-01-01', kind: 'period-start' },
          null,
          { kind: 'period-start' },
          { date: 42, kind: 'period-start' },
          { date: '2024-01-29', kind: 'period-start' },
        ],
      },
    });
    const parsed = parseBackup(text);
    expect(parsed.entries.map((entry) => entry.date)).toEqual(['2024-01-01', '2024-01-29']);
    expect(parsed.unreadableCount).toBe(3);
  });

  it('ignores top-level keys it does not know', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      formatVersion: 1,
      exportedOn: EXPORTED_ON,
      somethingLater: { added: true },
      log: { version: 1, entries: [{ date: '2024-01-01', kind: 'period-start' }] },
    });
    expect(parseBackup(text).entries).toHaveLength(1);
  });

  it('carries meta across whole', () => {
    const text = serializeBackup(
      { version: 1, entries: [{ date: '2024-01-01', kind: 'period-start', meta: { a: 1 } }] },
      EXPORTED_ON
    );
    expect(parseBackup(text).entries[0]?.meta).toEqual({ a: 1 });
  });
});

describe('round trip', () => {
  it('restores a synthetic history the engine analyses identically', async () => {
    const starts = syntheticStarts(20240601, 9);
    const original = logFromStartDates(starts);

    const source = await freshRepository();
    for (const entry of original.entries) await source.put(entry);
    // An end date too, so the round trip covers both kinds rather than only the
    // one the app writes most.
    const firstStart = starts[0];
    if (firstStart === undefined) throw new Error('generator produced no starts');
    await source.put({ date: firstStart, kind: 'period-end' });

    const exported = await source.load();
    const text = serializeBackup(exported, EXPORTED_ON);

    // A different device is an empty database and the file, and nothing else.
    await closeAll();
    await deleteDB(DB_NAME);
    const restoredRepo = repository();
    const parsed = parseBackup(text);
    const result = await restoredRepo.merge(parsed.entries);

    expect(parsed.unreadableCount).toBe(0);
    expect(result).toEqual({ added: exported.entries.length, alreadyPresent: 0 });

    const restored = await restoredRepo.load();
    expect(restored).toEqual(exported);

    const today = '2023-09-01';
    expect(analyze(restored, { today })).toEqual(analyze(exported, { today }));
  });

  it('is a no-op when the same file is imported twice', async () => {
    const starts = syntheticStarts(20240602, 5);
    const repo = await freshRepository();
    await repo.merge(logFromStartDates(starts).entries);

    const text = serializeBackup(await repo.load(), EXPORTED_ON);
    const before = await repo.load();

    const second = await repo.merge(parseBackup(text).entries);

    expect(second).toEqual({ added: 0, alreadyPresent: starts.length });
    expect(await repo.load()).toEqual(before);
  });

  it('adds what is missing without dropping what is already logged', async () => {
    const starts = syntheticStarts(20240603, 6);
    const older = starts.slice(0, 3);
    const newer = starts.slice(3);

    const backupText = serializeBackup(logFromStartDates(older), EXPORTED_ON);

    const repo = await freshRepository();
    await repo.merge(logFromStartDates(newer).entries);
    await repo.merge(parseBackup(backupText).entries);

    const restored = await repo.load();
    expect(restored.entries.map((entry) => entry.date)).toEqual([...starts].sort());
  });

  it('survives a log with an entry the engine itself cannot read', async () => {
    // The engine reports an unreadable date as `invalidEntries` and keeps going.
    // The backup has to keep going too, or her one bad row costs her the file.
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });
    await repo.put({ date: '2024-02-31', kind: 'period-start' });

    const text = serializeBackup(await repo.load(), EXPORTED_ON);
    const parsed = parseBackup(text);

    expect(parsed.unreadableCount).toBe(0);
    expect(parsed.entries.map((entry) => entry.date)).toEqual(['2024-01-01', '2024-02-31']);
  });
});
