/**
 * The repository against a real IndexedDB implementation.
 *
 * `fake-indexeddb` is the actual IDB algorithms in memory, not a stub of this
 * module's own API, so the transaction and keyPath behaviour these tests rely on
 * is the behaviour the browser will show.
 *
 * Every date here is hand-written and obviously synthetic: 2024-01-01 and exact
 * day steps from it. See docs/TESTING.md.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { IndexedDbLogRepository, sortEntries } from '../repository';
import { DB_NAME, DB_VERSION, MIGRATIONS } from '../schema';
import type { DayEntry } from '@/engine/types';

/**
 * Every connection this file opens, so it can be closed before the database is
 * deleted. An open connection blocks a delete, and a blocked delete hangs.
 */
const opened: IndexedDbLogRepository[] = [];

function repository(): IndexedDbLogRepository {
  const repo = new IndexedDbLogRepository();
  opened.push(repo);
  return repo;
}

async function closeAll(): Promise<void> {
  while (opened.length > 0) await opened.pop()?.close();
}

async function freshRepository(): Promise<IndexedDbLogRepository> {
  await closeAll();
  await deleteDB(DB_NAME);
  return repository();
}

afterEach(async () => {
  await closeAll();
  await deleteDB(DB_NAME);
});

describe('schema', () => {
  it('derives the database version from the migration ladder', () => {
    expect(DB_VERSION).toBe(MIGRATIONS.length);
    expect(DB_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('IndexedDbLogRepository', () => {
  it('starts empty and reports a version 1 log', async () => {
    const repo = await freshRepository();
    await expect(repo.load()).resolves.toEqual({ version: 1, entries: [] });
  });

  it('round-trips a period start through a reopened database', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });

    // A second repository is a second connection to the same stored bytes, which
    // is what a reload is.
    const reopened = repository();
    const log = await reopened.load();
    expect(log.entries).toEqual([{ date: '2024-01-01', kind: 'period-start' }]);
  });

  it('treats logging the same day twice as one fact', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });
    await repo.put({ date: '2024-01-01', kind: 'period-start' });

    const log = await repo.load();
    expect(log.entries).toHaveLength(1);
  });

  it('keeps a start and an end on the same day apart', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });
    await repo.put({ date: '2024-01-01', kind: 'period-end' });

    const log = await repo.load();
    expect(log.entries).toHaveLength(2);
  });

  it('deletes only the entry named', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });
    await repo.put({ date: '2024-01-04', kind: 'period-end' });

    await repo.remove('2024-01-01', 'period-start');

    const log = await repo.load();
    expect(log.entries).toEqual([{ date: '2024-01-04', kind: 'period-end' }]);
  });

  it('moves a mistyped date and carries meta across', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start', meta: { note: 'kept' } });

    await repo.move('period-start', '2024-01-01', '2024-01-02');

    const log = await repo.load();
    expect(log.entries).toEqual([
      { date: '2024-01-02', kind: 'period-start', meta: { note: 'kept' } },
    ]);
  });

  it('leaves the log alone when a move goes nowhere', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });

    await repo.move('period-start', '2024-01-01', '2024-01-01');

    const log = await repo.load();
    expect(log.entries).toEqual([{ date: '2024-01-01', kind: 'period-start' }]);
  });

  it('merges without touching entries it already has', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start', meta: { keep: 'mine' } });

    const result = await repo.merge([
      { date: '2024-01-01', kind: 'period-start', meta: { keep: 'theirs' } },
      { date: '2024-01-29', kind: 'period-start' },
    ]);

    expect(result).toEqual({ added: 1, alreadyPresent: 1 });
    const log = await repo.load();
    expect(log.entries).toEqual([
      { date: '2024-01-01', kind: 'period-start', meta: { keep: 'mine' } },
      { date: '2024-01-29', kind: 'period-start' },
    ]);
  });

  it('never drops an entry on merge, whatever order the file is in', async () => {
    const repo = await freshRepository();
    await repo.merge([
      { date: '2024-02-26', kind: 'period-start' },
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-29', kind: 'period-start' },
    ]);

    const log = await repo.load();
    expect(log.entries.map((entry) => entry.date)).toEqual([
      '2024-01-01',
      '2024-01-29',
      '2024-02-26',
    ]);
  });

  it('stores an entry kind it does not understand rather than discarding it', async () => {
    // The data model is designed so a later version can add a kind without a
    // migration. An older build must not be the thing that deletes it.
    const repo = await freshRepository();
    await repo.merge([{ date: '2024-01-01', kind: 'something-later' as DayEntry['kind'] }]);

    const log = await repo.load();
    expect(log.entries).toEqual([{ date: '2024-01-01', kind: 'something-later' }]);
  });

  it('does not invent a meta key on an entry that had none', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });

    const log = await repo.load();
    expect(Object.keys(log.entries[0] ?? {})).toEqual(['date', 'kind']);
  });

  it('clears the log without disturbing the meta store', async () => {
    const repo = await freshRepository();
    await repo.put({ date: '2024-01-01', kind: 'period-start' });
    await repo.setMeta('persistence', 'persisted');

    await repo.clear();

    expect((await repo.load()).entries).toEqual([]);
    await expect(repo.getMeta('persistence')).resolves.toBe('persisted');
  });

  it('reports an absent meta key as undefined rather than throwing', async () => {
    const repo = await freshRepository();
    await expect(repo.getMeta('never-written')).resolves.toBeUndefined();
  });
});

describe('sortEntries', () => {
  it('puts an unreadable date last instead of throwing', () => {
    const sorted = sortEntries([
      { date: 'not-a-date', kind: 'period-start' },
      { date: '2024-01-01', kind: 'period-start' },
    ]);
    expect(sorted.map((entry) => entry.date)).toEqual(['2024-01-01', 'not-a-date']);
  });

  it('breaks a same-day tie the same way every time', () => {
    const sorted = sortEntries([
      { date: '2024-01-01', kind: 'period-start' },
      { date: '2024-01-01', kind: 'period-end' },
    ]);
    expect(sorted.map((entry) => entry.kind)).toEqual(['period-end', 'period-start']);
  });

  it('does not mutate its input', () => {
    const input: readonly DayEntry[] = [
      { date: '2024-01-29', kind: 'period-start' },
      { date: '2024-01-01', kind: 'period-start' },
    ];
    sortEntries(input);
    expect(input[0]?.date).toBe('2024-01-29');
  });
});
