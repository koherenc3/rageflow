'use client';

/**
 * The screen she opens.
 *
 * It answers three questions and asks one: where in the cycle she is, when the
 * next period is likely, how sure the app is, and did it start today.
 *
 * The rule running through all of it is that nothing the engine withheld is
 * filled in here. The prediction has four states and each is rendered as its own
 * thing rather than as one layout with fields blanked out:
 *
 * - anchored to a logged start, so there is a range to show
 * - anchored to nothing, which is {@link ColdStartCard} and shows no dates
 * - late, where the range has been outlived and only the expected date survives
 * - stale, where the model has no dates left, and the phase card carries it
 *
 * The types make that structural rather than remembered. `prediction` is a
 * discriminated union, and {@link NextPeriodCard} accepts only the two variants
 * it can draw, so the branch that renders `interval80` is the only branch where
 * `interval80` exists.
 */

import Link from 'next/link';
import { compareDates, diffDays } from '@/engine/date';
import type {
  CurrentNextStartPrediction,
  CycleAnalysis,
  LateNextStartPrediction,
  NextStartPrediction,
  PhaseEstimate,
} from '@/engine/types';
import type { ISODate } from '@/engine/date';
import {
  confidenceLabel,
  formatDateRange,
  formatDay,
  formatDayWithWeekday,
  humanizeDates,
  phaseDisplay,
  relativeDays,
} from '@/lib/display';
import { useLogStore } from '@/lib/log-store';
import { LoadErrorScreen, LoadingScreen, Screen } from './Screen';
import { Button, Card, CardLabel, Disclaimer, Note } from './ui';

/** The small "estimate, not a record" marker. Carried by every predicted thing. */
function EstimateTag({ tone }: { tone: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]"
      style={{
        backgroundColor: `color-mix(in srgb, var(--phase-${tone}) 14%, transparent)`,
        color: `var(--phase-${tone})`,
      }}
    >
      Estimate
    </span>
  );
}

function PhaseCard({ phase, today }: { phase: PhaseEstimate; today: ISODate }) {
  const display = phaseDisplay(phase.phase);
  return (
    <Card tone={display.tone}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <CardLabel>Right now</CardLabel>
          <p
            className="mt-1.5 text-[1.6rem] font-semibold leading-tight tracking-tight"
            style={{ color: `var(--phase-${display.tone})` }}
          >
            {display.label}
          </p>
          {display.isEstimate && (
            <span className="mt-2 inline-block">
              <EstimateTag tone={display.tone} />
            </span>
          )}
        </div>
        {phase.dayOfCycle !== undefined && (
          <div className="shrink-0 text-right">
            <p className="text-[2.75rem] font-semibold leading-none tabular-nums text-fg">
              {phase.dayOfCycle}
            </p>
            <p className="mt-1 text-[0.6875rem] uppercase tracking-[0.08em] text-fg-faint">
              day of cycle
            </p>
          </div>
        )}
      </div>
      <p className="mt-4 text-sm leading-relaxed text-fg-muted">
        {humanizeDates(phase.summary, today)}
      </p>
    </Card>
  );
}

/**
 * The first thing she ever sees: nothing is logged, so there is no cycle to
 * place today in and nothing to predict from.
 *
 * It is one card rather than two. The phase card and the prediction card would
 * both be saying the same thing here, and two cards in a row explaining that
 * there is nothing yet reads as an app apologising rather than one waiting.
 *
 * The engine's own sentence is carried through instead of being paraphrased,
 * because it is the sentence that says the estimate is a population baseline,
 * and that is the claim that has to survive to the screen.
 */
function ColdStartCard({ coldStartMessage }: { coldStartMessage: string }) {
  return (
    <Card>
      <CardLabel>Right now</CardLabel>
      <p className="mt-1.5 text-[1.6rem] font-semibold leading-tight tracking-tight text-fg">
        Nothing logged yet
      </p>
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">
        Log the day your period started and rageflow will work out where you are in your cycle and
        when the next one is likely. One date is enough to begin.
      </p>
      <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-fg-faint">
        {coldStartMessage}
      </p>
    </Card>
  );
}

function ConfidenceBar({ prediction }: { prediction: NextStartPrediction }) {
  const width = Math.max(0, Math.min(1, prediction.confidence)) * 100;
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-fg">
          {confidenceLabel(prediction.confidenceTier)}
        </span>
        <span
          className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full"
          style={{ backgroundColor: 'var(--line)' }}
          role="presentation"
        >
          <span
            className="block h-full rounded-full"
            style={{ width: `${width}%`, backgroundColor: 'var(--accent)' }}
          />
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-fg-faint">{prediction.coldStartMessage}</p>
    </div>
  );
}

/**
 * The prediction, in whichever of its three showable states it is in.
 *
 * The 80% range is the headline because it is the honest answer. The point date
 * is under it, named as the most likely day rather than as the day, which is the
 * distinction the whole engine is built around.
 *
 * Two states do not reach here, and the caller handles both.
 *
 * A prediction anchored to nothing has its dates counted forward from today,
 * which is an arbitrary day she did not choose, so a range drawn from them would
 * read as a prediction about her when the engine has already said it is a
 * population baseline. That is {@link ColdStartCard}.
 *
 * A stale one has no dates at all, and the phase card above is already showing
 * the engine's stale sentence, which says there is no current cycle and what to
 * do about it. A second card restating that in slightly different words is the
 * app repeating itself, so there is one card rather than two.
 */
function NextPeriodCard({
  prediction,
  today,
}: {
  // Not `NextStartPrediction`: the stale variant is excluded in the type, so the
  // caller filtering it out is checked rather than remembered.
  prediction: CurrentNextStartPrediction | LateNextStartPrediction;
  today: ISODate;
}) {
  if (prediction.isLate) {
    return (
      // Untinted, unlike the phase card above it. Two amber cards stacked reads
      // as an alarm, and being a few days late is not one.
      <Card>
        <CardLabel>Next period</CardLabel>
        <p
          className="mt-1.5 text-[1.6rem] font-semibold leading-tight tracking-tight"
          style={{ color: 'var(--phase-late)' }}
        >
          {prediction.daysLate === 1 ? '1 day late' : `${prediction.daysLate} days late`}
        </p>
        {/* Structured rather than the engine's sentence, which the phase card
            above is already showing. Two cards saying the same thing in two
            different sets of words reads as the app repeating itself. */}
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Expected {formatDayWithWeekday(prediction.expectedDate, today)}, and the range around that
          date has passed with nothing logged since {formatDay(prediction.lastStartDate, today)}.
          Log a start when it arrives and the estimate picks up from there.
        </p>
        <ConfidenceBar prediction={prediction} />
      </Card>
    );
  }

  const daysAway = diffDays(today, prediction.pointDate);

  return (
    <Card>
      <CardLabel>Next period</CardLabel>
      <p className="mt-1.5 text-[1.75rem] font-semibold leading-tight tracking-tight text-fg">
        {formatDateRange(prediction.interval80.range.start, prediction.interval80.range.end, today)}
      </p>
      <p className="mt-1 text-sm text-fg-muted">80% chance it starts somewhere in this range</p>

      <dl className="mt-4 space-y-2 border-t border-line pt-4">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-fg-muted">Most likely</dt>
          <dd className="text-sm font-semibold text-fg">
            {formatDayWithWeekday(prediction.pointDate, today)}{' '}
            <span className="font-normal text-fg-faint">{relativeDays(daysAway)}</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-fg-muted">50% chance</dt>
          <dd className="text-sm font-semibold tabular-nums text-fg">
            {formatDateRange(
              prediction.interval50.range.start,
              prediction.interval50.range.end,
              today
            )}
          </dd>
        </div>
      </dl>

      <ConfidenceBar prediction={prediction} />
    </Card>
  );
}

/**
 * The fertile window, when it is still ahead of her.
 *
 * There is no fallback branch. Where the engine withheld the window, this
 * renders nothing at all rather than an estimate of its own, which is the
 * difference between reporting what the model knows and inventing something to
 * fill a card.
 *
 * It is a card only while the window is in the future. Inside it, the phase card
 * above already says so in the engine's own words and a second card repeating
 * the same dates is noise; behind her, a screen called Today should not lead
 * with something that finished last week. Neither is a change to what the engine
 * claimed, only to how many times one claim is on screen.
 */
function FertileWindowRow({ analysis }: { analysis: CycleAnalysis }) {
  const { fertileWindow, estimatedOvulationDate } = analysis.phases;
  if (fertileWindow === undefined) return null;
  if (compareDates(fertileWindow.start, analysis.today) <= 0) return null;
  return (
    <Card tone="fertile">
      <div className="flex items-center justify-between gap-3">
        <CardLabel>Fertile window ahead</CardLabel>
        <EstimateTag tone="fertile" />
      </div>
      <p
        className="mt-1.5 text-lg font-semibold leading-tight"
        style={{ color: 'var(--phase-fertile)' }}
      >
        {formatDateRange(fertileWindow.start, fertileWindow.end, analysis.today)}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        {estimatedOvulationDate === undefined
          ? 'Inferred from your cycle length alone.'
          : `Ovulation estimated around ${formatDay(estimatedOvulationDate, analysis.today)}, inferred from your cycle length alone.`}{' '}
        This is not an observation and not a method of contraception.
      </p>
    </Card>
  );
}

export function TodayScreen() {
  const store = useLogStore();

  if (store.loadError !== undefined) {
    return <LoadErrorScreen title="Today" message={store.loadError} />;
  }
  const { analysis, today, log } = store;
  if (store.loading || analysis === undefined || today === undefined || log === undefined) {
    return <LoadingScreen title="Today" />;
  }

  const startedToday = log.entries.some(
    (entry) => entry.kind === 'period-start' && entry.date === today
  );
  const endedToday = log.entries.some(
    (entry) => entry.kind === 'period-end' && entry.date === today
  );
  const currentCycle = analysis.cycles[analysis.cycles.length - 1];
  const canLogEnd =
    !endedToday &&
    currentCycle !== undefined &&
    currentCycle.endDate === undefined &&
    analysis.currentPhase?.phase === 'menstrual';

  // The engine's own signal for "there is nothing to anchor a prediction to".
  // Read off the prediction rather than counted off the cycles, so a log holding
  // only a future-dated start lands here too, where it belongs.
  const anchored = analysis.prediction.lastStartDate !== undefined;

  return (
    <Screen title="Today" subtitle={formatDayWithWeekday(today, today)}>
      {anchored ? (
        <>
          {analysis.currentPhase !== undefined && (
            <PhaseCard phase={analysis.currentPhase} today={today} />
          )}
          {!analysis.prediction.isStale && (
            <NextPeriodCard prediction={analysis.prediction} today={today} />
          )}
        </>
      ) : (
        <ColdStartCard coldStartMessage={analysis.coldStartMessage} />
      )}

      {/* A start she typed for a day that has not happened. The engine has not
          counted it, and this is the only screen she may have opened, so the
          reason it did nothing belongs here as well as on the Log screen. */}
      {analysis.futureDatedStarts.map((start) => (
        <Note key={start.date} tone="late">
          {humanizeDates(start.message, today)}
        </Note>
      ))}

      <FertileWindowRow analysis={analysis} />

      <div className="mt-1 flex flex-col gap-2">
        {startedToday ? (
          <div className="rounded-2xl border border-line bg-surface-raised px-5 py-4 text-center">
            <p className="text-base font-semibold text-fg">Period start logged for today</p>
            <Link
              href="/log"
              className="mt-1 inline-block text-sm font-semibold text-accent underline-offset-4"
            >
              Change or remove it
            </Link>
          </div>
        ) : (
          <Button
            variant="primary"
            full
            disabled={store.busy}
            onClick={() => void store.logStart(today).catch(() => undefined)}
          >
            My period started today
          </Button>
        )}

        {canLogEnd && (
          <Button
            variant="secondary"
            full
            disabled={store.busy}
            onClick={() => void store.logEnd(today).catch(() => undefined)}
          >
            It ended today
          </Button>
        )}

        {!startedToday && (
          <Link
            href="/log"
            className="inline-flex min-h-[3rem] items-center justify-center rounded-2xl text-[0.9375rem] font-medium text-accent"
          >
            It started another day
          </Link>
        )}
      </div>

      {store.actionError !== undefined && (
        <Note tone="menstrual" alert>
          {store.actionError}
        </Note>
      )}

      <Disclaimer />
    </Screen>
  );
}
