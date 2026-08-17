/**
 * The IndexedDB schema, and the ladder that gets an old database to it.
 *
 * There is exactly one user and her whole history lives in this database. There
 * is no server copy to rebuild it from, so the migration mechanism is here from
 * version 1 rather than added the first time the shape has to change: a ladder
 * with one rung is cheap, and retrofitting one onto a database that already
 * holds the only copy of her data is not.
 *
 * Rules for adding a rung:
 *
 * 1. Append to {@link MIGRATIONS}. Never edit or reorder an existing entry, and
 *    never renumber one. A database in the wild has already run the old code and
 *    will only ever run the rungs above where it stopped.
 * 2. `DB_VERSION` is derived from the ladder's length, so it cannot drift out of
 *    step with it.
 * 3. Each rung must be idempotent in the sense that it only ever runs once for a
 *    given database, and must work from the state the rung below it left behind.
 */

import type { IDBPDatabase, IDBPTransaction, DBSchema, StoreNames } from 'idb';
import type { DayEntryKind } from '@/engine/types';

export const DB_NAME = 'rageflow';

export const ENTRY_STORE = 'entries';
export const META_STORE = 'meta';

/**
 * One logged fact, as stored.
 *
 * The same shape as the engine's `DayEntry`, with `meta` written back exactly as
 * it was read. An older build must not destroy keys a newer one wrote, which is
 * why nothing here ever rebuilds an entry field by field.
 */
export interface StoredEntry {
  date: string;
  kind: DayEntryKind;
  meta?: Record<string, unknown>;
}

/** A row in the small key/value store beside the log. */
export interface MetaRecord {
  key: string;
  value: unknown;
}

export interface RageflowDB extends DBSchema {
  [ENTRY_STORE]: {
    /**
     * `[date, kind]`. Compound, so "her period started on the 3rd" can only be
     * in the log once however many times the button is pressed, and so a write
     * is an upsert rather than something that needs a read to be safe.
     */
    key: [string, DayEntryKind];
    value: StoredEntry;
    indexes: { 'by-date': string };
  };
  [META_STORE]: {
    key: string;
    value: MetaRecord;
  };
}

export type RageflowUpgradeTransaction = IDBPTransaction<
  RageflowDB,
  StoreNames<RageflowDB>[],
  'versionchange'
>;

export type Migration = (
  db: IDBPDatabase<RageflowDB>,
  tx: RageflowUpgradeTransaction,
  oldVersion: number
) => void;

/**
 * Index `i` upgrades a database at version `i` to version `i + 1`.
 *
 * Append only. See the rules at the top of this file.
 */
export const MIGRATIONS: readonly Migration[] = [
  // 0 -> 1: the original shape. The entry log, keyed by the day and what was
  // logged about it, and a key/value store for everything that is not health
  // data.
  (db) => {
    const entries = db.createObjectStore(ENTRY_STORE, { keyPath: ['date', 'kind'] });
    entries.createIndex('by-date', 'date');
    db.createObjectStore(META_STORE, { keyPath: 'key' });
  },
];

export const DB_VERSION = MIGRATIONS.length;

/** Run every rung above `oldVersion`. Shared by the real open and the tests. */
export function runMigrations(
  db: IDBPDatabase<RageflowDB>,
  tx: RageflowUpgradeTransaction,
  oldVersion: number
): void {
  for (let version = oldVersion; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) continue;
    migration(db, tx, oldVersion);
  }
}
