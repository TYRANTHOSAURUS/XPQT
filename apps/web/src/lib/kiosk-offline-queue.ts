/**
 * Kiosk offline queue.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.6
 *
 * When the kiosk loses network we still want the visitor's check-in attempt
 * to land — even if we can't show a "host has been notified" message. The
 * spec's contract: on offline, the visitor sees "Reception will be with you
 * shortly" (same wording as the online walk-up path) and the action is
 * queued; reception's today-view eventually sees the visitor row once the
 * device flushes the queue.
 *
 * v1 scope (intentionally minimal):
 *   - Single queue, FIFO, append-only on offline failure.
 *   - Best-effort flush on `window.online` AND on every kiosk page mount.
 *     Anything that still fails after a flush attempt stays queued.
 *   - No conflict resolution — if a token has expired by the time we
 *     reconnect, the backend will reject it and we surface a "couldn't
 *     check in offline entry" log; reception will see the visitor through
 *     the still-expected list anyway.
 *   - No deduping — the same QR scanned twice while offline is queued
 *     twice; the backend's single-use token logic takes care of it.
 *
 * Hand-rolled IndexedDB instead of pulling `idb`:
 *   - One object store, three operations (add / list / delete).
 *   - The kiosk is a focused surface; one new dep for ~80 lines of glue is
 *     not worth it.
 */

import { readKioskToken } from './kiosk-auth';

const DB_NAME = 'pq-kiosk';
const STORE = 'pending-checkins';
const DB_VERSION = 1;

export type QueuedKind = 'qr' | 'name' | 'walkup';

export interface QueuedItem {
  id?: number;
  kind: QueuedKind;
  /** ISO timestamp the offline check-in was captured. */
  capturedAt: string;
  /** The full request body the kiosk would have POSTed. */
  payload: unknown;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

export async function enqueueCheckin(item: QueuedItem): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('enqueue failed'));
    });
  } catch (err) {
    // We don't have a way to surface this to the user — the kiosk has
    // already shown "reception will be with you shortly". Log only.
    // Falling-through silently is the right v1 trade-off; the backend logs
    // the missing arrival when reception manually checks in.
    if (typeof console !== 'undefined') {
      console.warn('[kiosk] enqueue failed', err);
    }
  }
}

export async function listQueued(): Promise<QueuedItem[]> {
  try {
    const db = await openDb();
    return await new Promise<QueuedItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as QueuedItem[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('list failed'));
    });
  } catch {
    return [];
  }
}

export async function removeQueued(id: number): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[kiosk] remove failed', err);
    }
  }
}

/**
 * Best-effort flush — POSTs every queued item back to /api/kiosk/* using
 * the current kiosk token. Items that succeed are removed; items that
 * fail stay queued for the next flush.
 *
 * Returns the count of successfully drained items so callers can show a
 * tiny "x sync'd" indicator if they want. v1 doesn't surface this.
 */
export async function flushQueue(): Promise<{ flushed: number; remaining: number }> {
  const token = readKioskToken();
  if (!token) return { flushed: 0, remaining: 0 };
  const items = await listQueued();
  if (items.length === 0) return { flushed: 0, remaining: 0 };

  let flushed = 0;
  for (const item of items) {
    if (item.id == null) continue;
    const path = endpointFor(item.kind);
    try {
      const res = await fetch(`/api${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(item.payload),
      });
      if (res.ok) {
        await removeQueued(item.id);
        flushed += 1;
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx is "we don't agree with your request" — retrying won't help.
        // Drop the item to avoid re-queue forever.
        await removeQueued(item.id);
      }
      // 5xx + network: leave queued for next attempt.
    } catch {
      // Still offline. Bail out of the loop to avoid hammering.
      break;
    }
  }

  const remaining = (await listQueued()).length;
  return { flushed, remaining };
}

function endpointFor(kind: QueuedKind): string {
  switch (kind) {
    case 'qr':
      return '/kiosk/check-in/qr';
    case 'name':
      return '/kiosk/check-in/by-name';
    case 'walkup':
      return '/kiosk/walk-up';
  }
}
