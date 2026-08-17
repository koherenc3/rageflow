'use client';

/**
 * Where she types a date, and where she fixes one she got wrong.
 *
 * The whole input surface of the app is on this screen and it is two fields: the
 * day a period started, and optionally the day it ended. Nothing else is
 * collected, and the constraint is deliberate rather than unfinished.
 *
 * Editing and deleting are first-class rather than hidden behind a long press.
 * She will mistype a date, and a tracker that makes a wrong date hard to correct
 * is a tracker that quietly accumulates wrong dates, which is worse than one
 * that never had them.
 *
 * The date fields are native `<input type="date">`, which on an iPhone is the
 * system wheel picker. It is better than anything worth building here, it is
 * already familiar, and it hands back a `YYYY-MM-DD` string, which is exactly
 * what the engine stores. `max` is today: a period cannot have started on a day
 * that has not happened, and the engine reports a future-dated start as one it
 * has not counted, so the right place to prevent it is the field.
 */

import { useState } from 'react';
import { compareDates, isValidISODate, type ISODate } from '@/engine/date';
import type { CycleAnalysis, DayEntry, DayEntryKind } from '@/engine/types';
import { formatDay, formatDayWithWeekday, humanizeDates } from '@/lib/display';
import { messageOf, useLogStore, type LogStore } from '@/lib/log-store';
import { LoadErrorScreen, LoadingScreen, Screen } from './Screen';
import { Button, Card, CardLabel, Disclaimer, Note, SectionHeading } from './ui';

function kindLabel(kind: DayEntryKind): string {
  switch (kind) {
    case 'period-start':
      return 'Period started';
    case 'period-end':
      return 'Period ended';
    default:
      // An entry kind written by a later version. It is kept and shown as
      // itself rather than hidden, because a row she cannot see is a row she
      // cannot delete.
      return kind;
  }
}

function DateField({
  value,
  max,
  onChange,
  label,
}: {
  value: string;
  max: ISODate;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value}
      max={max}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-2xl border border-line-strong bg-surface px-4 text-base text-fg"
    />
  );
}

/** One row of her log, with the two things she can do to it. */
function EntryRow({ entry, today, store }: { entry: DayEntry; today: ISODate; store: LogStore }) {
  const [mode, setMode] = useState<'idle' | 'editing' | 'confirming-delete'>('idle');
  const [draft, setDraft] = useState<string>(entry.date);
  // A correction the repository refused, shown against the row it was refused
  // for. She is looking at this field, not at the foot of the screen.
  const [editError, setEditError] = useState<string | undefined>(undefined);
  const readable = isValidISODate(entry.date);
  const draftValid = isValidISODate(draft) && compareDates(draft, today) <= 0;

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-fg">
            {readable ? formatDayWithWeekday(entry.date, today) : String(entry.date)}
          </p>
          <p className="text-sm text-fg-muted">{kindLabel(entry.kind)}</p>
        </div>
        {mode === 'idle' && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="quiet"
              className="min-h-[2.75rem] px-3 text-sm"
              onClick={() => {
                setDraft(readable ? entry.date : today);
                setEditError(undefined);
                setMode('editing');
              }}
            >
              Edit
            </Button>
            {/* Quiet until it is armed. A row of red on every entry reads as a
                warning about her history rather than a thing she can do to it,
                and the confirmation step below is where the colour belongs. */}
            <Button
              variant="quiet"
              className="min-h-[2.75rem] px-3 text-sm"
              onClick={() => setMode('confirming-delete')}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {mode === 'editing' && (
        <div className="flex flex-col gap-2 pb-3">
          <DateField
            value={draft}
            max={today}
            onChange={(next) => {
              setEditError(undefined);
              setDraft(next);
            }}
            label={`New date for ${kindLabel(entry.kind).toLowerCase()}`}
          />
          {editError !== undefined && (
            <Note tone="menstrual" alert>
              {editError}
            </Note>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              disabled={!draftValid || store.busy}
              onClick={() => {
                setEditError(undefined);
                // A refused correction leaves the row open with her date still
                // in it, so the fix is one more tap rather than a retype.
                void store
                  .moveEntry(entry.kind, entry.date, draft)
                  .then(() => setMode('idle'))
                  .catch((error: unknown) => {
                    setEditError(messageOf(error, 'That date could not be changed.'));
                  });
              }}
            >
              Save
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                setEditError(undefined);
                setMode('idle');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === 'confirming-delete' && (
        <div className="flex flex-col gap-2 pb-3">
          <p className="text-sm text-fg-muted">
            Delete {kindLabel(entry.kind).toLowerCase()} on{' '}
            {readable ? formatDay(entry.date, today) : String(entry.date)}? This cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              disabled={store.busy}
              onClick={() => {
                // The failure is already on screen as a note, so the rejection
                // is absorbed here rather than left for the browser to log.
                void store
                  .removeEntry(entry.date, entry.kind)
                  .then(() => setMode('idle'))
                  .catch(() => undefined);
              }}
            >
              Delete
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => setMode('idle')}>
              Keep
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Everything the engine could not count, in its own words.
 *
 * All three of these exist so a row she can see in her log has an explanation
 * for why it is not the start of anything, instead of leaving her to wonder
 * where it went.
 */
function UncountedNotices({ analysis, today }: { analysis: CycleAnalysis; today: ISODate }) {
  const { futureDatedStarts, invalidEntries, missedLogSuspicions } = analysis;
  if (
    futureDatedStarts.length === 0 &&
    invalidEntries.length === 0 &&
    missedLogSuspicions.length === 0
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {futureDatedStarts.map((start) => (
        <Note key={`future-${start.date}`} tone="late">
          {humanizeDates(start.message, today)}
        </Note>
      ))}
      {invalidEntries.map((entry, index) => (
        <Note key={`invalid-${index}`} tone="late">
          {entry.message}
        </Note>
      ))}
      {missedLogSuspicions.map((suspicion) => (
        <Note key={`gap-${suspicion.cycleIndex}`} tone="stale">
          {humanizeDates(suspicion.question, today)} If you did, add it above and everything around
          it will correct itself.
        </Note>
      ))}
    </div>
  );
}

export function LogScreen() {
  const store = useLogStore();
  const [startDate, setStartDate] = useState<string | undefined>(undefined);
  const [endDate, setEndDate] = useState<string | undefined>(undefined);

  if (store.loadError !== undefined) {
    return <LoadErrorScreen title="Log" message={store.loadError} />;
  }
  const { analysis, today, log } = store;
  if (store.loading || analysis === undefined || today === undefined || log === undefined) {
    return <LoadingScreen title="Log" />;
  }

  const start = startDate ?? today;
  const end = endDate ?? today;
  const startValid = isValidISODate(start) && compareDates(start, today) <= 0;
  const endValid = isValidISODate(end) && compareDates(end, today) <= 0;
  const newestFirst = [...log.entries].reverse();

  return (
    <Screen title="Log" subtitle="Period start, and optionally when it ended.">
      <Card>
        <CardLabel>My period started</CardLabel>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Pick the first day of bleeding. It defaults to today.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <DateField
            value={start}
            max={today}
            onChange={setStartDate}
            label="Date the period started"
          />
          <Button
            variant="primary"
            full
            disabled={!startValid || store.busy}
            onClick={() => void store.logStart(start).catch(() => undefined)}
          >
            Save start date
          </Button>
        </div>
      </Card>

      <Card>
        <CardLabel>It ended</CardLabel>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Optional. The last day of bleeding, if you want to record it.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <DateField value={end} max={today} onChange={setEndDate} label="Date the period ended" />
          <Button
            variant="secondary"
            full
            disabled={!endValid || store.busy}
            onClick={() => void store.logEnd(end).catch(() => undefined)}
          >
            Save end date
          </Button>
        </div>
      </Card>

      {store.actionError !== undefined && (
        <Note tone="menstrual" alert>
          {store.actionError}
        </Note>
      )}

      <UncountedNotices analysis={analysis} today={today} />

      <SectionHeading>Everything logged</SectionHeading>
      {newestFirst.length === 0 ? (
        <Card>
          <p className="text-sm leading-relaxed text-fg-muted">
            Nothing logged yet. The first date you save appears here, and you can change or delete
            it at any time.
          </p>
        </Card>
      ) : (
        <Card className="py-1">
          <ul>
            {newestFirst.map((entry) => (
              <EntryRow
                key={`${String(entry.date)}-${entry.kind}`}
                entry={entry}
                today={today}
                store={store}
              />
            ))}
          </ul>
        </Card>
      )}

      <Disclaimer />
    </Screen>
  );
}
