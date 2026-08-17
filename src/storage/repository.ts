/**
 * The only thing that reads or writes her history.
 *
 * The engine takes a `CycleLog` in and returns an analysis out; this is where
 * that log comes from. Keeping it behind an interface means the browser is one
 * implementation rather than an assumption baked through the UI, and it is what
 * lets the round-trip tests run the real logic against an in-memory IndexedDB.
 *
 * Every date that crosses this boundary is a `YYYY-MM-DD` calendar date. Nothing
 * here stores an instant, and nothing here calls `Date`.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { CycleLog, DayEntry, DayEntryKind } from '@/engine/types';
import { compareDates, isValidISODate, type ISODate } from '@/engine/date';
import {
  DB_NAME,
  DB_VERSION,
  ENTRY_STORE,
  META_STORE,
  runMigrations,
  type RageflowDB,
  type StoredEntry,
} from './schema';

/** What an import did, so the UI can report it rather than claim it. */
export interface MergeResult {
  /** Entries in the file that were not already in the log. */
  added: number;
  /** Entries in the file the log already had, on the same day and kind. */
  alreadyPresent: number;
}

export interface LogRepository {
  load(): Promise<CycleLog>;
  /** Upsert. Logging the same day twice is the same one fact, not two. */
  put(entry: DayEntry): Promise<void>;
  remove(date: ISODate, kind: DayEntryKind): Promise<void>;
  /** Correct a mistyped date, carrying any `meta` across with it. */
  move(kind: DayEntryKind, from: ISODate, to: ISODate): Promise<void>;
  /** Add what is missing and touch nothing that is already there. */
  merge(entries: readonly DayEntry[]): Promise<MergeResult>;
  clear(): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  /**
   * Drop the connection.
   *
   * The app never calls this: the page holds one connection for its lifetime and
   * the browser closes it. It exists because an open connection blocks a version
   * upgrade or a delete of the database, which is the shape of every test that
   * starts from a clean database.
   */
  close(): Promise<void>;
}

function toStored(entry: DayEntry): StoredEntry {
  return {
    date: entry.date,
    kind: entry.kind,
    // Spread rather than assign, so an entry that never had `meta` is not given
    // an `undefined` one: IndexedDB would store the key, and the export would
    // then round-trip a field she never had.
    ...(entry.meta === undefined ? {} : { meta: { ...entry.meta } }),
  };
}

function toDayEntry(stored: StoredEntry): DayEntry {
  return {
    date: stored.date,
    kind: stored.kind,
    ...(stored.meta === undefined ? {} : { meta: stored.meta }),
  };
}

/**
 * Oldest first, and stable for anything the engine would refuse to read.
 *
 * The engine does not need the order and says so, but the UI lists these and a
 * list that reshuffles itself between reads is its own kind of broken. An
 * unreadable date sorts last rather than throwing, because one bad row must not
 * make the rest of her history unreadable; the engine reports it as
 * `invalidEntries` and the UI shows it there.
 */
function byDateThenKind(a: DayEntry, b: DayEntry): number {
  const aValid = isValidISODate(a.date);
  const bValid = isValidISODate(b.date);
  if (aValid && bValid) {
    const byDate = compareDates(a.date, b.date);
    if (byDate !== 0) return byDate;
  } else if (aValid !== bValid) {
    return aValid ? -1 : 1;
  } else {
    const byRaw = String(a.date).localeCompare(String(b.date));
    if (byRaw !== 0) return byRaw;
  }
  return a.kind.localeCompare(b.kind);
}

export function sortEntries(entries: readonly DayEntry[]): DayEntry[] {
  return [...entries].sort(byDateThenKind);
}

export type DatabaseFactory = () => Promise<IDBPDatabase<RageflowDB>>;

export function openRageflowDB(): Promise<IDBPDatabase<RageflowDB>> {
  return openDB<RageflowDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      runMigrations(db, tx, oldVersion);
    },
  });
}

export class IndexedDbLogRepository implements LogRepository {
  private connection: Promise<IDBPDatabase<RageflowDB>> | undefined;

  constructor(private readonly open: DatabaseFactory = () => openRageflowDB()) {}

  private db(): Promise<IDBPDatabase<RageflowDB>> {
    // Opened once and reused. A second `openDB` while an upgrade is in flight is
    // how you get a blocked transaction that never settles.
    this.connection ??= this.open();
    return this.connection;
  }

  async load(): Promise<CycleLog> {
    const db = await this.db();
    const stored = await db.getAll(ENTRY_STORE);
    return { version: 1, entries: sortEntries(stored.map(toDayEntry)) };
  }

  async put(entry: DayEntry): Promise<void> {
    const db = await this.db();
    await db.put(ENTRY_STORE, toStored(entry));
  }

  async remove(date: ISODate, kind: DayEntryKind): Promise<void> {
    const db = await this.db();
    await db.delete(ENTRY_STORE, [date, kind]);
  }

  async move(kind: DayEntryKind, from: ISODate, to: ISODate): Promise<void> {
    if (from === to) return;
    const db = await this.db();
    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    const existing = await tx.store.get([from, kind]);
    // One transaction, so a correction can never land as a delete without the
    // matching write. `meta` rides along: she is fixing the date, not discarding
    // whatever else was attached to the entry.
    await tx.store.delete([from, kind]);
    await tx.store.put({
      date: to,
      kind,
      ...(existing?.meta === undefined ? {} : { meta: existing.meta }),
    });
    await tx.done;
  }

  async merge(entries: readonly DayEntry[]): Promise<MergeResult> {
    const db = await this.db();
    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    let added = 0;
    let alreadyPresent = 0;
    for (const entry of entries) {
      const existing = await tx.store.get([entry.date, entry.kind]);
      if (existing !== undefined) {
        alreadyPresent += 1;
        continue;
      }
      await tx.store.put(toStored(entry));
      added += 1;
    }
    await tx.done;
    return { added, alreadyPresent };
  }

  async clear(): Promise<void> {
    const db = await this.db();
    await db.clear(ENTRY_STORE);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.db();
    const record = await db.get(META_STORE, key);
    return record === undefined ? undefined : (record.value as T);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    await db.put(META_STORE, { key, value });
  }

  async close(): Promise<void> {
    const pending = this.connection;
    if (pending === undefined) return;
    this.connection = undefined;
    (await pending).close();
  }
}
