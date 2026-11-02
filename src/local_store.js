const DB_NAME = 'neurotrace-v6-local';
const DB_VERSION = 1;
let openPromise;

function openDatabase() {
  if (openPromise) return openPromise;
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'session_id' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('Could not open local research storage.'));
    request.onblocked = () => reject(new Error('Local research storage is blocked by another tab.'));
  });
  return openPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

/** Persist a consent or completed session for retryable synchronization. */
export async function enqueue(item) {
  const db = await openDatabase();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put({ ...item, queued_at: item.queued_at || new Date().toISOString(), attempts: item.attempts || 0, next_attempt_at: item.next_attempt_at || 0 });
  await transactionDone(tx);
}

/** List queued writes, with consent records ahead of trajectory sessions. */
export async function listOutbox() {
  const db = await openDatabase();
  const tx = db.transaction('outbox', 'readonly');
  const done = transactionDone(tx);
  const items = await requestResult(tx.objectStore('outbox').getAll());
  await done;
  return items.sort((a, b) => (a.type === b.type ? a.queued_at.localeCompare(b.queued_at) : a.type === 'consent' ? -1 : 1));
}

/** Update retry metadata without dropping the original queued payload. */
export async function updateOutbox(item) {
  const db = await openDatabase();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put(item);
  await transactionDone(tx);
}

/** Remove an item only after Firebase has acknowledged its idempotent write. */
export async function removeOutbox(id) {
  const db = await openDatabase();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(id);
  await transactionDone(tx);
}

/** Save a consented, unfinished session draft locally. */
export async function saveDraft(draft) {
  const db = await openDatabase();
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').put(draft);
  await transactionDone(tx);
}

/** Retrieve all unfinished local sessions so a participant can resume after a reload. */
export async function listDrafts() {
  const db = await openDatabase();
  const tx = db.transaction('drafts', 'readonly');
  const done = transactionDone(tx);
  const drafts = await requestResult(tx.objectStore('drafts').getAll());
  await done;
  return drafts.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

/** Retrieve an unfinished local session, if one exists. */
export async function getDraft(sessionId) {
  const db = await openDatabase();
  const tx = db.transaction('drafts', 'readonly');
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore('drafts').get(sessionId));
  await done;
  return result || null;
}

/** Delete a draft after successful queueing or explicit user withdrawal. */
export async function deleteDraft(sessionId) {
  const db = await openDatabase();
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').delete(sessionId);
  await transactionDone(tx);
}

/** Remove all pending, not-yet-synchronized submissions at the user's request. */
export async function clearOutbox() {
  const db = await openDatabase();
  const tx = db.transaction(['outbox', 'drafts'], 'readwrite');
  tx.objectStore('outbox').clear();
  tx.objectStore('drafts').clear();
  await transactionDone(tx);
}

/** Return the current local queue size for transparent UI status. */
export async function outboxCount() {
  const items = await listOutbox();
  return items.length;
}
