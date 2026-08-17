'use client';

/**
 * The one place the app holds her log, and the only thing that calls the engine.
 *
 * Everything on screen is a function of two values: the log, which comes out of
 * IndexedDB, and today, which comes off the local clock. The analysis is derived
 * from those two and never stored, for the same reason the engine derives cycles
 * rather than storing them: a cached copy is a copy that can disagree with what
 * she actually typed.
 *
 * Today is state rather than a value read at render time, and it is re-read when
 * the tab comes back and on a timer. This app is installed to a home screen and
 * left open for days. If today were captured once at load, the button that logs
 * "my period started today" would write yesterday's date after midnight, which
 * is the exact failure the whole calendar-date design exists to prevent.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { analyze, todayLocal } from '@/engine';
import type { CycleAnalysis, CycleLog, DayEntry, DayEntryKind } from '@/engine/types';
import type { ISODate } from '@/engine/date';
import { IndexedDbLogRepository, type LogRepository, type MergeResult } from '@/storage/repository';
import { parseBackup, serializeBackup } from '@/storage/backup';
import { requestPersistence, type PersistenceState } from '@/storage/persistence';

const PERSISTENCE_META_KEY = 'storage-persistence';

export interface LogStore {
  /** True until the first read of the database has settled. */
  loading: boolean;
  /**
   * Set when the database could not be opened or read. Everything else is
   * undefined in that case, so the UI shows the failure rather than an empty
   * history that looks like a fresh start.
   */
  loadError?: string;
  /** Set by the last action that failed. Cleared when the next one succeeds. */
  actionError?: string;
  log?: CycleLog;
  analysis?: CycleAnalysis;
  /** The local calendar date, re-read as the day turns over. */
  today?: ISODate;
  persistence: PersistenceState | 'unknown';
  /** True while a write is in flight, so a button cannot be pressed twice. */
  busy: boolean;

  logStart(date: ISODate): Promise<void>;
  logEnd(date: ISODate): Promise<void>;
  removeEntry(date: ISODate, kind: DayEntryKind): Promise<void>;
  /**
   * Correct a date. Throws with a readable message when the repository refuses,
   * and leaves `actionError` alone: this one is reported next to the row being
   * edited, which is where she is looking, rather than at the foot of the screen.
   */
  moveEntry(kind: DayEntryKind, from: ISODate, to: ISODate): Promise<void>;
  /**
   * Merge a backup file in. Returns what it did, or throws with a readable
   * message. Like `moveEntry`, the caller reports the failure, so it does not
   * also land in `actionError` and reappear on another screen.
   */
  importBackup(text: string): Promise<MergeResult & { unreadableCount: number }>;
  /** The file contents. Building it is the store's job; saving it is the caller's. */
  exportBackup(): string;
}

const LogStoreContext = createContext<LogStore | undefined>(undefined);

export function useLogStore(): LogStore {
  const store = useContext(LogStoreContext);
  if (store === undefined) {
    throw new Error('useLogStore must be used inside a LogProvider');
  }
  return store;
}

/**
 * What a failed action says for itself, or a fallback when it has nothing worth
 * showing. The repository and the parser both throw sentences written for her,
 * and those are shown as they are rather than reworded at each call site.
 */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

export function LogProvider({
  children,
  repository,
}: {
  children: ReactNode;
  /** Injectable so a test or a story can supply its own. Defaults to IndexedDB. */
  repository?: LogRepository;
}) {
  const fallbackRepository = useRef<LogRepository>(undefined);
  const repo = useMemo(() => {
    if (repository !== undefined) return repository;
    fallbackRepository.current ??= new IndexedDbLogRepository();
    return fallbackRepository.current;
  }, [repository]);

  const [log, setLog] = useState<CycleLog | undefined>(undefined);
  // Undefined until the client mounts. The server has no idea what day it is
  // where she is, so rendering a date during SSR would either be wrong or would
  // hydrate into a different one.
  const [today, setToday] = useState<ISODate | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [persistence, setPersistence] = useState<PersistenceState | 'unknown'>('unknown');

  useEffect(() => {
    let cancelled = false;
    setToday(todayLocal());

    void (async () => {
      try {
        const loaded = await repo.load();
        if (cancelled) return;
        setLog(loaded);
      } catch (error) {
        if (cancelled) return;
        setLoadError(
          messageOf(error, 'Your history could not be opened. Nothing has been changed.')
        );
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Asked after the first read rather than before it, so a browser that
      // takes its time over the permission does not hold up the first paint.
      const state = await requestPersistence();
      if (cancelled) return;
      setPersistence(state);
      try {
        await repo.setMeta(PERSISTENCE_META_KEY, state);
      } catch {
        // Recording the answer is a convenience. Failing to is not worth
        // reporting over the top of an app that is otherwise working.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repo]);

  useEffect(() => {
    const tick = () => {
      setToday((current) => {
        const now = todayLocal();
        return now === current ? current : now;
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', tick);
    };
  }, []);

  /**
   * Every write goes through here: do the thing, then re-read the log.
   *
   * Re-reading rather than patching the state in place means what is on screen
   * is what is in the database, so a write that half succeeded cannot leave the
   * UI showing an entry that is not there.
   */
  const perform = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      setBusy(true);
      try {
        const result = await action();
        setLog(await repo.load());
        setActionError(undefined);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [repo]
  );

  /**
   * `perform`, plus the failure in the shared field the screens render.
   *
   * An action whose caller shows the failure itself uses `perform` directly. Two
   * places would otherwise report the same error, and the shared field outlives
   * the screen it was set on, so it would surface again somewhere she never did
   * the thing that failed.
   */
  const run = useCallback(
    <T,>(action: () => Promise<T>, fallbackMessage: string): Promise<T> =>
      perform(action).catch((error: unknown) => {
        setActionError(messageOf(error, fallbackMessage));
        throw error;
      }),
    [perform]
  );

  const put = useCallback(
    (entry: DayEntry, fallbackMessage: string) =>
      run(() => repo.put(entry), fallbackMessage).then(() => undefined),
    [repo, run]
  );

  const logStart = useCallback(
    (date: ISODate) => put({ date, kind: 'period-start' }, 'That period start could not be saved.'),
    [put]
  );

  const logEnd = useCallback(
    (date: ISODate) => put({ date, kind: 'period-end' }, 'That end date could not be saved.'),
    [put]
  );

  const removeEntry = useCallback(
    (date: ISODate, kind: DayEntryKind) =>
      run(() => repo.remove(date, kind), 'That entry could not be deleted.').then(() => undefined),
    [repo, run]
  );

  const moveEntry = useCallback(
    (kind: DayEntryKind, from: ISODate, to: ISODate) =>
      perform(() => repo.move(kind, from, to)).then(() => undefined),
    [repo, perform]
  );

  const importBackup = useCallback(
    (text: string) =>
      perform(async () => {
        const parsed = parseBackup(text);
        const merged = await repo.merge(parsed.entries);
        return { ...merged, unreadableCount: parsed.unreadableCount };
      }),
    [repo, perform]
  );

  const exportBackup = useCallback(() => {
    if (log === undefined || today === undefined) {
      throw new Error('There is nothing to export yet.');
    }
    return serializeBackup(log, today);
  }, [log, today]);

  const analysis = useMemo(
    () => (log === undefined || today === undefined ? undefined : analyze(log, { today })),
    [log, today]
  );

  const value = useMemo<LogStore>(
    () => ({
      loading,
      ...(loadError === undefined ? {} : { loadError }),
      ...(actionError === undefined ? {} : { actionError }),
      ...(log === undefined ? {} : { log }),
      ...(analysis === undefined ? {} : { analysis }),
      ...(today === undefined ? {} : { today }),
      persistence,
      busy,
      logStart,
      logEnd,
      removeEntry,
      moveEntry,
      importBackup,
      exportBackup,
    }),
    [
      loading,
      loadError,
      actionError,
      log,
      analysis,
      today,
      persistence,
      busy,
      logStart,
      logEnd,
      removeEntry,
      moveEntry,
      importBackup,
      exportBackup,
    ]
  );

  return <LogStoreContext.Provider value={value}>{children}</LogStoreContext.Provider>;
}
