/**
 * Test-only helpers for the storage tests. Not shipped and not imported by
 * anything under `src/` outside this directory.
 *
 * Every repository these tests open is tracked here so it can be closed before
 * the database is deleted. An open connection blocks a delete, a blocked delete
 * never settles, and a hung teardown is the one failure mode that makes a whole
 * suite look broken. Defining that discipline once means a new storage test file
 * cannot get it subtly wrong.
 */

import { afterEach } from 'vitest';
import { deleteDB } from 'idb';
import { IndexedDbLogRepository } from '../repository';
import { DB_NAME } from '../schema';

const opened: IndexedDbLogRepository[] = [];

/** A repository on the current database, tracked so teardown can close it. */
export function repository(): IndexedDbLogRepository {
  const repo = new IndexedDbLogRepository();
  opened.push(repo);
  return repo;
}

export async function closeAll(): Promise<void> {
  while (opened.length > 0) await opened.pop()?.close();
}

/** An empty database and one connection to it, which is what a new phone is. */
export async function freshRepository(): Promise<IndexedDbLogRepository> {
  await closeAll();
  await deleteDB(DB_NAME);
  return repository();
}

/**
 * Close every connection and delete the database after each test.
 *
 * Called at the top level of a test file rather than run on import, so a file
 * that uses one of the helpers above says out loud that it also takes the
 * teardown.
 */
export function withCleanDatabase(): void {
  afterEach(async () => {
    await closeAll();
    await deleteDB(DB_NAME);
  });
}
