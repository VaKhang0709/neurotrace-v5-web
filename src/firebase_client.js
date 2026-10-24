import { firebaseConfig, researchContactEmail, researchControllerName, researchControllerAddress } from '../config/firebase_config.js';

const SDK_ROOT = 'https://www.gstatic.com/firebasejs/10.14.1';
const REQUIRED_CONFIG = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
let servicePromise;
let analyticsPromise;

/** Check that all Firebase web configuration placeholders have deployment values. */
export function isFirebaseConfigured() {
  return REQUIRED_CONFIG.every(key => typeof firebaseConfig[key] === 'string' && firebaseConfig[key].trim().length > 0);
}

/** Require a project binding and a working research contact before enabling uploads. */
export function isCollectionConfigured() {
  return isFirebaseConfigured()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(researchContactEmail)
    && researchControllerName.trim().length >= 3
    && researchControllerAddress.trim().length >= 8;
}

/** Initialize the modular Firebase SDK only when a configured project is available. */
export async function getFirebaseServices() {
  if (!isFirebaseConfigured()) throw new Error('Firebase project configuration is empty.');
  if (!servicePromise) {
    servicePromise = Promise.all([
      import(`${SDK_ROOT}/firebase-app.js`),
      import(`${SDK_ROOT}/firebase-auth.js`),
      import(`${SDK_ROOT}/firebase-firestore.js`),
      import(`${SDK_ROOT}/firebase-storage.js`)
    ]).then(async ([appSdk, authSdk, firestoreSdk, storageSdk]) => {
      const app = appSdk.initializeApp(firebaseConfig);
      const auth = authSdk.getAuth(app);
      const db = firestoreSdk.getFirestore(app);
      const storage = storageSdk.getStorage(app);
      if (!auth.currentUser) await authSdk.signInAnonymously(auth);
      return { app, auth, authSdk, db, firestoreSdk, storage, storageSdk, analytics: null };
    }).catch(error => {
      servicePromise = null;
      throw new Error(`Firebase initialization failed: ${error?.message || 'unknown error'}`);
    });
  }
  return servicePromise;
}

/** Initialize Firebase Analytics after the participant has accepted the displayed research/privacy terms. */
export async function initializeAnalyticsAfterConsent() {
  if (!isCollectionConfigured()) return null;
  if (!analyticsPromise) {
    analyticsPromise = (async () => {
      const [{ app }, analyticsSdk] = await Promise.all([getFirebaseServices(), import(`${SDK_ROOT}/firebase-analytics.js`)]);
      if (!(await analyticsSdk.isSupported())) return null;
      return analyticsSdk.getAnalytics(app);
    })().catch(() => null);
  }
  return analyticsPromise;
}

/** Write a consent-only record; drawing trajectories are never included in this collection. */
export async function storeConsent(consent) {
  if (!isCollectionConfigured()) throw new Error('Collection is offline until Firebase and research contact details are configured.');
  const services = await getFirebaseServices();
  const { doc, setDoc, serverTimestamp } = services.firestoreSdk;
  const ownerUid = services.auth.currentUser?.uid;
  if (!ownerUid) throw new Error('Anonymous Firebase authentication is unavailable.');
  await setDoc(doc(services.db, 'v6_consents', consent.consent_id), {
    ...consent,
    owner_uid: ownerUid,
    created_at: serverTimestamp()
  });
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function uploadTaskTrajectory(services, session, task) {
  const { ref, uploadBytes } = services.storageSdk;
  const path = `v6_trajectories/${services.auth.currentUser.uid}/${session.session_id}/${task.task_id}.json`;
  const body = JSON.stringify({ session_id: session.session_id, task_id: task.task_id, task_version: task.task_version, trajectory: task.trajectory });
  await uploadBytes(ref(services.storage, path), new Blob([body], { type: 'application/json' }), {
    contentType: 'application/json',
    customMetadata: { session_id: session.session_id, task_id: task.task_id }
  });
  task.trajectory = null;
  task.trajectory_storage_path = path;
  task.trajectory_format = 'json';
}

/** Upload oversized trajectories privately and create the Firestore session document idempotently. */
export async function storeSession(sessionPayload) {
  if (!isCollectionConfigured()) throw new Error('Collection is offline until Firebase and research contact details are configured.');
  const services = await getFirebaseServices();
  const { doc, setDoc, serverTimestamp } = services.firestoreSdk;
  const ownerUid = services.auth.currentUser?.uid;
  if (!ownerUid) throw new Error('Anonymous Firebase authentication is unavailable.');
  const session = typeof structuredClone === 'function'
    ? structuredClone(sessionPayload)
    : JSON.parse(JSON.stringify(sessionPayload));
  session.owner_uid = ownerUid;
  const tasks = Array.isArray(session.tasks) ? session.tasks : [];
  const thresholdBytes = 800 * 1024;
  const serializedTaskSizes = tasks.map(task => task.trajectory ? byteLength(task.trajectory) : 0);
  let documentSize = byteLength(session);
  const candidates = tasks.map((task, index) => ({ task, size: serializedTaskSizes[index] })).filter(item => item.task.trajectory).sort((a, b) => b.size - a.size);
  for (const item of candidates) {
    if (item.size > 1024 * 1024 || documentSize > thresholdBytes) {
      await uploadTaskTrajectory(services, session, item.task);
      documentSize = byteLength(session);
    }
  }
  if (byteLength(session) >= 1024 * 1024) throw new Error('Session metadata exceeds Firestore document limits after trajectory offload.');
  session.created_at = serverTimestamp();
  await setDoc(doc(services.db, 'v6_sessions', session.session_id), session);
}

/** Read only the aggregate public dashboard document; individual sessions are never queried publicly. */
export async function getPublicStats() {
  if (!isFirebaseConfigured()) throw new Error('Dashboard service is not configured.');
  const [appSdk, firestoreSdk] = await Promise.all([
    import(`${SDK_ROOT}/firebase-app.js`),
    import(`${SDK_ROOT}/firebase-firestore.js`)
  ]);
  const app = appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(firebaseConfig);
  const db = firestoreSdk.getFirestore(app);
  const snapshot = await firestoreSdk.getDoc(firestoreSdk.doc(db, 'v6_public_stats', 'current'));
  return snapshot.exists() ? snapshot.data() : null;
}
