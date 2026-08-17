'use client';

/**
 * Her past cycles, and how well the app has actually been doing.
 *
 * The accuracy block is the part that matters. An app that predicts a date and
 * never says how the last prediction went is asking to be trusted on nothing;
 * the engine replays the log and grades every prediction it would have made, so
 * the honest thing is to show that measurement, including when it is bad.
 *
 * It is measured, so it only appears once there is something to measure. With no
 * graded predictions the engine reports `NaN` rather than zero, and every figure
 * here reads that as having nothing to say instead of printing a `0%` nobody
 * measured.
 */

import { diffDays } from '@/engine/date';
import type { CalibrationSummary, ClinicalNote, DerivedCycle } from '@/engine/types';
import type { ISODate } from '@/engine/date';
import { formatDay, formatDays, formatPercent, humanizeDates } from '@/lib/display';
import { useLogStore } from '@/lib/log-store';
import { BackupSection } from './BackupSection';
import { LoadErrorScreen, LoadingScreen, Screen } from './Screen';
import { Card, CardLabel, Disclaimer, Note, SectionHeading, Stat } from './ui';

function CycleRow({ cycle, today }: { cycle: DerivedCycle; today: ISODate }) {
  const inProgress = cycle.lengthDays === undefined;
  const elapsed = diffDays(cycle.startDate, today);

  return (
    <li className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-base font-semibold text-fg">{formatDay(cycle.startDate, today)}</p>
        <p className="text-sm text-fg-muted">
          {cycle.periodLengthDays === undefined
            ? 'No end date logged'
            : `Bled ${cycle.periodLengthDays} ${cycle.periodLengthDays === 1 ? 'day' : 'days'}`}
          {cycle.suspectedMissedLog && ' - gap looks like a missed log'}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {inProgress ? (
          <>
            <p className="text-lg font-semibold tabular-nums text-accent">{elapsed + 1}</p>
            <p className="text-[0.6875rem] uppercase tracking-[0.08em] text-fg-faint">
              in progress
            </p>
          </>
        ) : (
          <>
            <p className="text-lg font-semibold tabular-nums text-fg">{cycle.lengthDays}</p>
            <p className="text-[0.6875rem] uppercase tracking-[0.08em] text-fg-faint">days</p>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The accuracy block.
 *
 * Coverage is the number worth reading: an 80% interval that contains the real
 * date about 80% of the time is a calibrated one, and both directions off that
 * mean something. It is labelled with what it should be, so the figure beside it
 * can be judged rather than just read.
 */
function AccuracyCard({ calibration, today }: { calibration: CalibrationSummary; today: ISODate }) {
  if (calibration.sampleCount === 0) {
    return (
      <Card>
        <CardLabel>Accuracy</CardLabel>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Nothing to measure yet. Once rageflow has predicted a period and you have logged the one
          that followed, its own accuracy shows up here, whatever it turns out to be.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardLabel>Accuracy</CardLabel>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        {humanizeDates(calibration.summary, today)}
      </p>
      <dl className="mt-3 divide-y divide-line border-t border-line pt-1">
        <Stat label="Predictions graded" value={String(calibration.sampleCount)} />
        <Stat label="Typical miss" value={formatDays(calibration.meanAbsoluteErrorDays)} />
        <Stat label="Median miss" value={formatDays(calibration.medianAbsoluteErrorDays)} />
        <Stat label="Landed in the 50% range" value={formatPercent(calibration.coverage50)} />
        <Stat label="Landed in the 80% range" value={formatPercent(calibration.coverage80)} />
        <Stat
          label="Typical 80% range width"
          value={formatDays(calibration.meanInterval80WidthDays)}
        />
      </dl>
      {calibration.widenFactor > 1 && (
        <p className="mt-3 text-xs leading-relaxed text-fg-faint">
          Because those ranges have been missing more often than they should, rageflow is currently
          widening new ones by {Math.round(calibration.widenFactor * 100) / 100}x.
        </p>
      )}
    </Card>
  );
}

/**
 * Clinical flags, phrased as observations.
 *
 * The engine names what it saw and suggests mentioning it to a doctor. It never
 * names a cause or a condition, and nothing is added here, which is why these
 * are a calm note at the bottom of a screen rather than a banner at the top of
 * one.
 */
function ClinicalNotes({ notes, today }: { notes: readonly ClinicalNote[]; today: ISODate }) {
  if (notes.length === 0) return null;
  return (
    <>
      <SectionHeading>Worth mentioning to a doctor</SectionHeading>
      <div className="flex flex-col gap-2">
        {notes.map((note) => (
          <Note key={`${note.cycleIndex}-${note.flag}`} tone="stale">
            {humanizeDates(note.message, today)}
          </Note>
        ))}
      </div>
    </>
  );
}

export function HistoryScreen() {
  const store = useLogStore();

  if (store.loadError !== undefined) {
    return <LoadErrorScreen title="History" message={store.loadError} />;
  }
  const { analysis, today } = store;
  if (store.loading || analysis === undefined || today === undefined) {
    return <LoadingScreen title="History" />;
  }

  const newestFirst = [...analysis.cycles].reverse();
  const completed = analysis.cycles.filter((cycle) => cycle.lengthDays !== undefined).length;

  return (
    <Screen
      title="History"
      subtitle={
        analysis.cycles.length === 0
          ? 'Nothing logged yet.'
          : `${completed} complete ${completed === 1 ? 'cycle' : 'cycles'}, ${analysis.usedCycleCount} used in the estimate.`
      }
    >
      {newestFirst.length === 0 ? (
        <Card>
          <CardLabel>Cycles</CardLabel>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            Your cycles appear here as you log period start dates. A cycle is the gap between two
            starts, so the second date you log is the one that produces the first cycle.
          </p>
        </Card>
      ) : (
        <Card className="py-1">
          <ul>
            {newestFirst.map((cycle) => (
              <CycleRow key={cycle.index} cycle={cycle} today={today} />
            ))}
          </ul>
        </Card>
      )}

      <AccuracyCard calibration={analysis.calibration} today={today} />

      <ClinicalNotes notes={analysis.clinicalNotes} today={today} />

      <BackupSection />

      <Disclaimer />
    </Screen>
  );
}
