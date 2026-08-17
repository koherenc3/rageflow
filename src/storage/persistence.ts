/**
 * Asking the browser not to evict her history.
 *
 * IndexedDB is best-effort storage by default. A browser under disk pressure is
 * entitled to throw a site's database away, and this database is the only copy
 * of everything she has logged. `navigator.storage.persist()` is the request not
 * to, and it is asked once on first run.
 *
 * It can be refused, and on iOS the answer depends on whether the app is
 * installed to the home screen. The result is reported rather than assumed, so
 * the UI can tell her to keep a backup when the browser said no instead of
 * quietly hoping.
 */

export type PersistenceState =
  /** The browser promised to keep it. */
  | 'persisted'
  /** The browser was asked and said no. Eviction is possible. */
  | 'best-effort'
  /** No Storage API here, so there was nothing to ask. */
  | 'unsupported';

export async function requestPersistence(): Promise<PersistenceState> {
  if (typeof navigator === 'undefined' || navigator.storage === undefined) return 'unsupported';
  const { storage } = navigator;
  if (typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') {
    return 'unsupported';
  }
  try {
    if (await storage.persisted()) return 'persisted';
    return (await storage.persist()) ? 'persisted' : 'best-effort';
  } catch {
    // A refusal and a thrown refusal mean the same thing to her.
    return 'best-effort';
  }
}
