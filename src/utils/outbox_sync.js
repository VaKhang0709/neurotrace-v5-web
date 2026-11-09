/**
 * Synchronize a snapshot of IndexedDB outbox items using injected Firebase and
 * storage adapters. This keeps the retry/acknowledgment contract testable
 * without credentials, public collection, or a live Firestore project.
 */
export async function synchronizeOutbox({
  items,
  localStore,
  storeConsent,
  storeSession,
  isConsentSynced,
  markConsentSynced,
  now = () => Date.now(),
  maxRetryMs = 60 * 60 * 1000
}) {
  const failedConsentIds = new Set();
  const syncedConsentIds = new Set();
  const confirmedSessionIds = new Set();
  const failedSessionIds = new Set();

  for (const item of items) {
    if (item.next_attempt_at > now()) continue;
    if (item.type === 'session' && failedConsentIds.has(item.payload.consent_id)) continue;
    try {
      if (item.type === 'consent') {
        await storeConsent(item.payload);
        syncedConsentIds.add(item.payload.consent_id);
        markConsentSynced(item.payload.consent_id);
      } else if (item.type === 'session') {
        const consentId = item.payload.consent_id;
        const consentSynced = syncedConsentIds.has(consentId) || isConsentSynced(consentId);
        const consentStillQueued = items.some(candidate => candidate.type === 'consent' && candidate.payload.consent_id === consentId);
        if (!consentSynced && consentStillQueued) {
          failedConsentIds.add(consentId);
          continue;
        }
        await storeSession(item.payload);
        confirmedSessionIds.add(item.payload.session_id);
      } else {
        continue;
      }
      await localStore.removeOutbox(item.id);
    } catch (error) {
      if (item.type === 'consent') failedConsentIds.add(item.payload.consent_id);
      if (item.type === 'session') failedSessionIds.add(item.payload.session_id);
      const attempts = (item.attempts || 0) + 1;
      const delay = Math.min(maxRetryMs, 1000 * (2 ** Math.min(attempts, 12)));
      await localStore.updateOutbox({
        ...item,
        attempts,
        next_attempt_at: now() + delay,
        last_error: String(error?.message || error).slice(0, 300)
      });
    }
  }

  return {
    remaining: await localStore.listOutbox(),
    confirmedSessionIds,
    failedSessionIds
  };
}
