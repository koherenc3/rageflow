/**
 * Export and import, which in this version is her only backup.
 *
 * There is no server copy. If this does not round-trip exactly then the file she
 * saved is not a backup, it is a story about one, so the shape here is
 * deliberately boring: the log verbatim, wrapped in enough envelope to tell what
 * wrote it and refuse a file that was written by something else.
 *
 * The envelope carries a calendar date and never an instant. `exportedOn` is the
 * day she pressed the button, which is all a backup label needs, and putting a
 * timestamp there would be the one place in the app that stores a moment in
 * time.
 */

import type { CycleLog, DayEntry, DayEntryKind } from '@/engine/types';
import type { ISODate } from '@/engine/date';

export const BACKUP_FORMAT = 'rageflow-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** The calendar day the file was written. Never a timestamp. */
  exportedOn: ISODate;
  log: CycleLog;
}

export interface ParsedBackup {
  backup: Backup;
  entries: readonly DayEntry[];
  /**
   * Rows the parser could not read at all: not an object, or missing a date or
   * a kind it could store. Counted rather than silently dropped, so an import
   * can say what it did not take.
   */
  unreadableCount: number;
}

export class BackupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One row of the file.
 *
 * `kind` is taken at its word rather than checked against the two this version
 * knows. The data model exists so a later version can add an entry kind without
 * a migration, and the engine skips a kind it does not recognise instead of
 * failing on it, so refusing one here would make this build delete data a later
 * build wrote. The same reasoning covers `meta`, which is carried across whole.
 */
function readEntry(row: unknown): DayEntry | undefined {
  if (!isRecord(row)) return undefined;
  if (typeof row.date !== 'string') return undefined;
  if (typeof row.kind !== 'string') return undefined;
  const meta = isRecord(row.meta) ? row.meta : undefined;
  return {
    date: row.date,
    kind: row.kind as DayEntryKind,
    ...(meta === undefined ? {} : { meta }),
  };
}

/** Build the file contents. Pure, so the round-trip test does not need a DOM. */
export function buildBackup(log: CycleLog, exportedOn: ISODate): Backup {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedOn,
    log: { version: log.version, entries: log.entries.map((entry) => ({ ...entry })) },
  };
}

export function serializeBackup(log: CycleLog, exportedOn: ISODate): string {
  return `${JSON.stringify(buildBackup(log, exportedOn), null, 2)}\n`;
}

/**
 * Read a file back.
 *
 * Throws only where the file is not one of ours at all. A file that is ours but
 * has a row this version cannot store comes back with the rows it could read and
 * a count of the rest, because refusing the whole restore over one bad row is
 * the worse failure when this file is the only copy.
 */
export function parseBackup(text: string): ParsedBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupParseError('That file is not JSON, so there is nothing to restore from it.');
  }

  if (!isRecord(parsed)) {
    throw new BackupParseError('That file does not contain a rageflow backup.');
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new BackupParseError(
      'That file was not written by rageflow, so restoring from it would not be safe.'
    );
  }
  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new BackupParseError('That backup does not say which format version it is.');
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupParseError(
      `That backup was written by a newer version of rageflow (format ${formatVersion}). Update the app before restoring it.`
    );
  }

  const log = parsed.log;
  if (!isRecord(log) || !Array.isArray(log.entries)) {
    throw new BackupParseError('That backup has no entries in it.');
  }

  const entries: DayEntry[] = [];
  let unreadableCount = 0;
  for (const row of log.entries) {
    const entry = readEntry(row);
    if (entry === undefined) {
      unreadableCount += 1;
      continue;
    }
    entries.push(entry);
  }

  const exportedOn = typeof parsed.exportedOn === 'string' ? parsed.exportedOn : '';

  return {
    backup: {
      format: BACKUP_FORMAT,
      formatVersion,
      exportedOn,
      log: { version: 1, entries },
    },
    entries,
    unreadableCount,
  };
}

/** `rageflow-2026-08-17.rageflow.json`. The suffix is what `.gitignore` keys on. */
export function backupFileName(exportedOn: ISODate): string {
  return `rageflow-${exportedOn}.rageflow.json`;
}
