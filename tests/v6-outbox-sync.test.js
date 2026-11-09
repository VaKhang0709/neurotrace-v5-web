import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeOutbox } from '../src/utils/outbox_sync.js';

function mockStore(items) {
  const outbox = new Map(items.map(item => [item.id, structuredClone(item)]));
  return {
    outbox,
    async removeOutbox(id) { outbox.delete(id); },
    async updateOutbox(item) { outbox.set(item.id, structuredClone(item)); },
    async listOutbox() { return [...outbox.values()]; }
  };
}

function sampleItems() {
  return [
    { id: 'consent-1', type: 'consent', payload: { consent_id: 'consent-1' }, attempts: 0, next_attempt_at: 0 },
    { id: 'session-1', type: 'session', payload: { session_id: 'session-1', consent_id: 'consent-1' }, attempts: 0, next_attempt_at: 0 }
  ];
}

test('mocked Firestore acknowledgments remove consent/session queue items and confirm only the session write', async () => {
  const localStore = mockStore(sampleItems());
  const acknowledgments = [];
  const result = await synchronizeOutbox({
    items: await localStore.listOutbox(),
    localStore,
    storeConsent: async payload => { acknowledgments.push(`consent:${payload.consent_id}`); },
    storeSession: async payload => { acknowledgments.push(`session:${payload.session_id}`); },
    isConsentSynced: () => false,
    markConsentSynced: id => acknowledgments.push(`marked:${id}`),
    now: () => 1000
  });
  assert.deepEqual(acknowledgments, ['consent:consent-1', 'marked:consent-1', 'session:session-1']);
  assert.equal(result.remaining.length, 0);
  assert.deepEqual([...result.confirmedSessionIds], ['session-1']);
  assert.equal(result.failedSessionIds.size, 0);
});

test('failed mocked session write remains queued with retry metadata and is not server-confirmed', async () => {
  const localStore = mockStore(sampleItems());
  const result = await synchronizeOutbox({
    items: await localStore.listOutbox(),
    localStore,
    storeConsent: async () => {},
    storeSession: async () => { throw new Error('mock permission denied'); },
    isConsentSynced: () => false,
    markConsentSynced: () => {},
    now: () => 1000
  });
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].id, 'session-1');
  assert.equal(result.remaining[0].attempts, 1);
  assert.equal(result.remaining[0].next_attempt_at, 3000);
  assert.match(result.remaining[0].last_error, /mock permission denied/);
  assert.equal(result.confirmedSessionIds.size, 0);
  assert.deepEqual([...result.failedSessionIds], ['session-1']);
});

test('session write is blocked when its queued consent write fails', async () => {
  const localStore = mockStore(sampleItems());
  let sessionWriteAttempted = false;
  const result = await synchronizeOutbox({
    items: await localStore.listOutbox(),
    localStore,
    storeConsent: async () => { throw new Error('mock consent write denied'); },
    storeSession: async () => { sessionWriteAttempted = true; },
    isConsentSynced: () => false,
    markConsentSynced: () => {},
    now: () => 1000
  });
  assert.equal(sessionWriteAttempted, false);
  assert.equal(result.confirmedSessionIds.size, 0);
  assert.equal(result.remaining.length, 2);
  assert.equal(result.remaining.find(item => item.id === 'consent-1').attempts, 1);
});
