'use client';

/**
 * Export and import, which in this version is the only backup there is.
 *
 * Nothing leaves the device. The export builds the file in memory and hands it
 * to the browser's own save flow, and the import reads a file she picked. There
 * is no upload, no server, and no third party in either direction, which is the
 * whole reason this is a file and not a sync.
 *
 * The import merges rather than replaces. Replacing is what "restore" usually
 * means, and it is also the one operation here that can destroy data: pick a
 * backup from three months ago and everything since is gone, with no undo and no
 * second copy anywhere. Merging cannot lose an entry. What it can do is bring
 * back one she deleted, and that is recoverable on the Log screen in two taps,
 * so the failure it risks is the one that can be walked back.
 */

import { useRef, useState } from 'react';
import { backupFileName } from '@/storage/backup';
import { useLogStore } from '@/lib/log-store';
import { Button, Card, CardLabel } from './ui';

type Outcome = { kind: 'ok'; message: string } | { kind: 'error'; message: string };

export function BackupSection() {
  const store = useLogStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);

  const { today } = store;

  function save() {
    if (today === undefined) return;
    try {
      const blob = new Blob([store.exportBackup()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName(today);
      link.click();
      URL.revokeObjectURL(url);
      setOutcome({ kind: 'ok', message: `Saved as ${backupFileName(today)}.` });
    } catch (error) {
      setOutcome({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The backup could not be created.',
      });
    }
  }

  async function restore(file: File) {
    try {
      const result = await store.importBackup(await file.text());
      const parts = [
        result.added === 1 ? 'Added 1 entry.' : `Added ${result.added} entries.`,
        result.alreadyPresent > 0 ? `${result.alreadyPresent} were already logged.` : '',
        result.unreadableCount > 0
          ? `${result.unreadableCount} could not be read and were left out.`
          : '',
      ].filter((part) => part !== '');
      setOutcome({ kind: 'ok', message: parts.join(' ') });
    } catch (error) {
      setOutcome({
        kind: 'error',
        message: error instanceof Error ? error.message : 'That file could not be restored.',
      });
    }
  }

  return (
    <Card>
      <CardLabel>Backup</CardLabel>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        Your history lives on this device and nowhere else. Save a copy somewhere you will still
        have it if you lose the phone.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <Button variant="secondary" full disabled={today === undefined} onClick={save}>
          Save a backup file
        </Button>
        <Button
          variant="secondary"
          full
          disabled={store.busy}
          onClick={() => fileInput.current?.click()}
        >
          Restore from a file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the same file twice fires the change event the
            // second time as well.
            event.target.value = '';
            if (file !== undefined) void restore(file);
          }}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-fg-faint">
        Restoring adds anything in the file that is not already logged. It never removes what you
        have.
      </p>

      {outcome !== undefined && (
        <p
          className="mt-3 rounded-2xl px-4 py-3 text-sm leading-relaxed"
          role="status"
          style={{
            backgroundColor:
              outcome.kind === 'ok' ? 'var(--phase-follicular-soft)' : 'var(--danger-soft)',
            color: outcome.kind === 'ok' ? 'var(--phase-follicular)' : 'var(--danger)',
          }}
        >
          {outcome.message}
        </p>
      )}

      {store.persistence === 'best-effort' && (
        <p className="mt-3 text-xs leading-relaxed text-fg-faint">
          This browser would not promise to keep the data if it runs short on space. Installing
          rageflow to your home screen usually changes that answer, and a backup file covers it
          either way.
        </p>
      )}
    </Card>
  );
}
