import { preprocessV5Trial, standardizeV5Window } from '../preprocess_v5.js';
import { consentVersion } from '../config/firebase_config.js';
import { initializeAnalyticsAfterConsent, isCollectionConfigured, storeConsent, storeSession } from './firebase_client.js';
import * as localStore from './local_store.js';

const TASK_IDS = ['archimedes_spiral', 'static_spiral_trace', 'straight_line', 'sine_wave', 'free_handwriting', 'rapid_circles'];
const TASK_TITLE_KEYS = ['task1Title', 'task2Title', 'task3Title', 'task4Title', 'task5Title', 'task6Title'];
const TASK_PROMPT_KEYS = ['task1Prompt', 'task2Prompt', 'task3Prompt', 'task4Prompt', 'task5PromptEn', 'task6Prompt'];
const FINGERPRINT_KEYS = ['neurotrace_device_uuid', 'neurotrace_device_fp'];
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const MAX_RETRY_MS = 60 * 60 * 1000;
const TEXT_ENCODER = new TextEncoder();

const $ = id => document.getElementById(id);
const canvasElements = TASK_IDS.map((_, index) => $(`taskCanvas${index}`));
const contexts = canvasElements.map(canvas => canvas.getContext('2d', { alpha: true, desynchronized: true }));
const panels = [...document.querySelectorAll('.task-card')];
const taskStates = TASK_IDS.map(task_id => ({
  task_id,
  task_version: 'v1',
  trajectory: [],
  canvas_size: null,
  pointer_types: new Set(),
  active_stroke_index: -1,
  started_at_us: null,
  ended_at_us: null,
  duration_ms: 0,
  v5_inference_result: { probability: null, classification: 'unavailable' },
  completed: false,
  skipped: false
}));
const i18n = { en: {}, vi: {} };
let locale = 'en';
let activeTaskIndex = 0;
let pointerActive = false;
const activePointerIds = new Set();
const strokeIndexByPointerId = new Map();
let renderPending = false;
let inferencePending = false;
let sessionQueued = false;
let sessionId = null;
let sessionStartedAt = new Date().toISOString();
let consentId = null;
let deviceUuid = null;
let deviceFingerprint = null;
let sessionMetadata = null;
let localStorageAvailable = true;
let currentDraft = null;
let availableDrafts = [];
let currentDraftIndex = 0;
let syncRunning = false;
let retryTimer = null;
let pendingAutosave = null;
let draftWriteQueue = Promise.resolve();
let lastPointerType = 'unknown';
let modelSessionPromise;
let scalerPromise;
let ortRuntime = null;

function secureUuidV4() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) throw new Error('A cryptographically secure browser context is required.');
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi.getRandomValues !== 'function') throw new Error('Secure random number generation is not available.');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getElementText(key, fallback = '') {
  return i18n[locale][key] || fallback || key;
}

async function loadTranslations(language) {
  const response = await fetch(`./i18n/${language}.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${language} translations (${response.status}).`);
  i18n[language] = await response.json();
}

function applyLanguage(language) {
  locale = language === 'vi' ? 'vi' : 'en';
  document.documentElement.lang = locale;
  document.title = getElementText('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const value = getElementText(element.dataset.i18n);
    if (value) element.textContent = value;
  });
  $('task5Prompt').textContent = getElementText(locale === 'vi' ? 'task5PromptVi' : 'task5PromptEn');
  updateCountryOptions();
  updateTaskUi();
  updateBadge();
}

function updateCountryOptions() {
  const select = $('country');
  if (!select) return;
  const selected = select.value;
  const display = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale], { type: 'region' }) : null;
  select.replaceChildren(new Option(getElementText('countryPlaceholder', 'Select a country'), ''));
  for (const code of COUNTRY_CODES) {
    let name = code;
    try { name = display?.of(code) || code; } catch { /* Keep ISO code if locale data is unavailable. */ }
    select.add(new Option(name, code));
  }
  select.value = selected;
}

function readLocalStorage(key) {
  try { return localStorage.getItem(key); }
  catch { localStorageAvailable = false; return null; }
}

function writeLocalStorage(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { localStorageAvailable = false; return false; }
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure SHA-256 hashing requires HTTPS and Web Crypto support.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getOrCreateIdentity() {
  if (!localStorageAvailable) throw new Error('Browser storage is blocked. Enable local storage before participating.');
  let uuid = readLocalStorage(FINGERPRINT_KEYS[0]);
  if (!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    uuid = secureUuidV4();
    if (!writeLocalStorage(FINGERPRINT_KEYS[0], uuid)) throw new Error('Could not save the local research identifier.');
  }
  const existingFingerprint = readLocalStorage(FINGERPRINT_KEYS[1]);
  let fingerprint = existingFingerprint;
  if (!fingerprint) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const seed = [screen.width, screen.height, navigator.userAgent, timezone].join('|');
    fingerprint = await sha256Hex(seed);
    if (!writeLocalStorage(FINGERPRINT_KEYS[1], fingerprint)) throw new Error('Could not save the local device fingerprint.');
  }
  return { uuid, fingerprint };
}

function updateBadge() {
  const badge = $('firebaseBadge');
  const online = isCollectionConfigured() && navigator.onLine;
  badge.textContent = online ? getElementText('online') : getElementText('offline');
  badge.classList.toggle('online', online);
  badge.classList.toggle('offline', !online);
}

function createSpiralPath(width, height, turns = 3, scale = 1) {
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) * 0.38 * scale;
  const end = turns * Math.PI * 2;
  const steps = Math.max(120, Math.round(turns * 100));
  let path = '';
  for (let i = 0; i <= steps; i++) {
    const theta = end * i / steps;
    const radius = maxRadius * i / steps;
    const x = cx + Math.cos(theta) * radius;
    const y = cy + Math.sin(theta) * radius;
    path += `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
  }
  return path.trim();
}

function configureTemplates() {
  document.querySelectorAll('.template-svg[data-template]').forEach(svg => {
    const path = svg.querySelector('path');
    const template = svg.dataset.template;
    const rect = svg.parentElement.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 420;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    let d = '';
    if (template === 'spiral') d = createSpiralPath(width, height, 3, 1);
    if (template === 'line') {
      const length = Math.min(378, width * 0.9);
      d = `M${(width - length) / 2} ${height / 2} L${(width + length) / 2} ${height / 2}`;
    }
    if (template === 'sine') {
      for (let i = 0; i <= 160; i++) {
        const x = width * (0.06 + i / 160 * 0.88);
        const y = height / 2 - Math.sin(i / 160 * Math.PI * 4) * height * 0.25;
        d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `;
      }
    }
    if (template === 'circles') {
      const points = [];
      for (let circle = 0; circle < 10; circle++) {
        const cx = width * (0.08 + circle * 0.093);
        const cy = height * (circle % 2 ? 0.61 : 0.39);
        const radius = Math.min(28, width * 0.035, height * 0.09);
        for (let i = 0; i <= 28; i++) {
          const theta = i / 28 * Math.PI * 2;
          points.push(`${i === 0 ? 'M' : 'L'}${(cx + Math.cos(theta) * radius).toFixed(1)} ${(cy + Math.sin(theta) * radius).toFixed(1)}`);
        }
      }
      d = points.join(' ');
    }
    if (path) path.setAttribute('d', d);
  });
  const reference = document.querySelector('.reference-spiral');
  if (reference) reference.setAttribute('d', createSpiralPath(180, 180, 3, 1));
}

function currentCanvasRect(index = activeTaskIndex) {
  return canvasElements[index].getBoundingClientRect();
}

function renderTask(index) {
  const canvas = canvasElements[index];
  const ctx = contexts[index];
  const state = taskStates[index];
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!state.trajectory.length) return;
  const original = state.canvas_size || { w: rect.width, h: rect.height };
  const scaleX = rect.width / original.w;
  const scaleY = rect.height / original.h;
  ctx.beginPath();
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#65e3d2';
  let previousStroke = null;
  state.trajectory.forEach(row => {
    const x = row[0] * scaleX;
    const y = row[1] * scaleY;
    const strokeIndex = row[13] ?? 0;
    if (strokeIndex !== previousStroke) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    previousStroke = strokeIndex;
  });
  ctx.stroke();
}

function resizeCanvas(index) {
  const canvas = canvasElements[index];
  const ctx = contexts[index];
  const stage = canvas.parentElement;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderTask(index);
}

function scheduleRender(index) {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderTask(index);
  });
}

function updateTaskUi() {
  panels.forEach((panel, index) => { panel.hidden = index !== activeTaskIndex; });
  configureTemplates();
  const state = taskStates[activeTaskIndex];
  const doneCount = taskStates.filter(task => task.completed).length;
  $('taskProgressText').textContent = getElementText('taskOf').replace('{current}', String(activeTaskIndex + 1)).replace('{total}', '6');
  $('progressFill').style.width = `${doneCount / 6 * 100}%`;
  $('progressTrack')?.setAttribute('aria-valuenow', String(doneCount));
  document.querySelectorAll('#taskNav button').forEach((button, index) => {
    button.setAttribute('aria-current', index === activeTaskIndex ? 'step' : 'false');
    button.dataset.state = taskStates[index].skipped ? 'skipped' : taskStates[index].completed ? 'done' : 'pending';
    button.setAttribute('aria-label', `${index + 1}. ${getElementText(TASK_TITLE_KEYS[index])}${taskStates[index].skipped ? ', skipped' : taskStates[index].completed ? ', complete' : ''}`);
  });
  $('previousTask').disabled = activeTaskIndex === 0 || pointerActive || inferencePending;
  const thisCompletesProtocol = taskStates.every((task, index) => index === activeTaskIndex || task.completed || task.skipped);
  $('nextTask').textContent = getElementText(thisCompletesProtocol ? 'finishTasks' : 'next');
  $('nextTask').disabled = state.skipped || pointerActive || inferencePending;
  $('skipTask').disabled = pointerActive || inferencePending;
  $('redoTask').disabled = pointerActive || inferencePending;
  $('taskStatus' + activeTaskIndex).textContent = getElementText('points').replace('{count}', String(state.trajectory.length));
  resizeCanvas(activeTaskIndex);
}

function showTask(index) {
  if (pointerActive || inferencePending || index < 0 || index >= taskStates.length) return;
  activeTaskIndex = index;
  $('protocol').hidden = false;
  $('feedback').hidden = true;
  updateTaskUi();
  panels[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function createTaskNav() {
  const nav = $('taskNav');
  TASK_IDS.forEach((_, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(index + 1);
    button.addEventListener('click', () => showTask(index));
    nav.append(button);
  });
}

function pointerSample(event, canvas, index) {
  const rect = canvas.getBoundingClientRect();
  const timeUs = Math.round(performance.now() * 1000);
  const state = taskStates[index];
  if (!state.canvas_size) {
    state.canvas_size = { w: rect.width, h: rect.height };
    const stage = canvas.parentElement;
    stage.style.width = `${rect.width}px`;
    stage.style.height = `${rect.height}px`;
  }
  const pointerType = typeof event.pointerType === 'string' && event.pointerType ? event.pointerType : 'unknown';
  const nativePressure = pointerType !== 'mouse' && Number.isFinite(event.pressure) && event.pressure >= 0
    ? event.pressure
    : null;
  const row = [
    event.clientX - rect.left,
    event.clientY - rect.top,
    timeUs,
    nativePressure,
    Number.isFinite(event.tiltX) ? event.tiltX : null,
    Number.isFinite(event.tiltY) ? event.tiltY : null,
    Number.isFinite(event.twist) ? event.twist : null,
    pointerType,
    Number.isFinite(event.pointerId) ? event.pointerId : null,
    Number.isFinite(event.buttons) ? event.buttons : null,
    Number.isFinite(event.width) ? event.width : null,
    Number.isFinite(event.height) ? event.height : null,
    Boolean(event.isPrimary),
    strokeIndexByPointerId.get(event.pointerId) ?? state.active_stroke_index
  ];
  state.trajectory.push(row);
  state.pointer_types.add(pointerType);
  state.started_at_us ??= timeUs;
  state.ended_at_us = timeUs;
  state.duration_ms = Math.max(0, (state.ended_at_us - state.started_at_us) / 1000);
  lastPointerType = pointerType;
  const note = $('taskStatus' + index);
  note.textContent = getElementText('points').replace('{count}', String(state.trajectory.length));
  scheduleRender(index);
  scheduleDraftSave();
}

function processPointerEvent(event, canvas, index) {
  const nativeEvents = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  const events = nativeEvents.length ? [...nativeEvents] : [];
  const last = events[events.length - 1];
  const parentAlreadyIncluded = last && last.pointerId === event.pointerId
    && last.timeStamp === event.timeStamp && last.clientX === event.clientX && last.clientY === event.clientY;
  if (!events.length || !parentAlreadyIncluded) events.push(event);
  for (const sample of events) pointerSample(sample, canvas, index);
}

function attachPointerCapture(canvas, index) {
  canvas.addEventListener('pointerdown', event => {
    if (index !== activeTaskIndex || inferencePending || activePointerIds.has(event.pointerId)) return;
    event.preventDefault();
    pointerActive = true;
    activePointerIds.add(event.pointerId);
    const state = taskStates[index];
    state.skipped = false;
    state.completed = false;
    state.active_stroke_index += 1;
    strokeIndexByPointerId.set(event.pointerId, state.active_stroke_index);
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable; pointer events still record. */ }
    processPointerEvent(event, canvas, index);
    updateTaskUi();
  });
  canvas.addEventListener('pointermove', event => {
    if (!activePointerIds.has(event.pointerId) || index !== activeTaskIndex) return;
    event.preventDefault();
    processPointerEvent(event, canvas, index);
  });
  const finish = event => {
    if (index !== activeTaskIndex || event?.pointerId === undefined || !activePointerIds.has(event.pointerId)) return;
    if (event.type === 'pointerup') processPointerEvent(event, canvas, index);
    activePointerIds.delete(event.pointerId);
    strokeIndexByPointerId.delete(event.pointerId);
    pointerActive = activePointerIds.size > 0;
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
    const state = taskStates[index];
    state.ended_at_us = Math.round(performance.now() * 1000);
    state.duration_ms = state.started_at_us === null ? 0 : Math.max(0, (state.ended_at_us - state.started_at_us) / 1000);
    $('captureStatus').textContent = getElementText('taskSaved');
    updateTaskUi();
    scheduleDraftSave(true);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('lostpointercapture', finish);
}

function initializePointerCanvases() {
  canvasElements.forEach((canvas, index) => attachPointerCapture(canvas, index));
  window.addEventListener('resize', () => {
    if (!pointerActive) { configureTemplates(); resizeCanvas(activeTaskIndex); }
  });
}

function resetCurrentTask() {
  if (pointerActive || inferencePending) return;
  const state = taskStates[activeTaskIndex];
  state.trajectory = [];
  state.canvas_size = null;
  state.pointer_types.clear();
  state.active_stroke_index = -1;
  state.started_at_us = null;
  state.ended_at_us = null;
  state.duration_ms = 0;
  state.v5_inference_result = { probability: null, classification: 'unavailable' };
  state.completed = false;
  state.skipped = false;
  const stage = canvasElements[activeTaskIndex].parentElement;
  stage.style.width = '';
  stage.style.height = '';
  scheduleRender(activeTaskIndex);
  updateTaskUi();
  scheduleDraftSave(true);
}

function estimateSampleRate(tasks) {
  const intervals = [];
  for (const task of tasks) {
    const times = task.trajectory.map(row => row[2]);
    for (let i = 1; i < times.length; i++) {
      const dtUs = times[i] - times[i - 1];
      if (dtUs > 0) intervals.push(dtUs / 1000);
    }
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const medianMs = intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2;
  return medianMs > 0 ? 1000 / medianMs : null;
}

function extractHealthStatus() {
  return document.querySelector('input[name="health_status"]:checked')?.value || '';
}

function setConditionalFields() {
  const status = extractHealthStatus();
  const isPd = status === 'parkinsons_clinically_diagnosed';
  const isOther = status === 'other_neurological_diagnosis';
  $('parkinsonsGroup').hidden = !isPd;
  $('otherConditionGroup').hidden = !isOther;
  $('yearsDiagnosis').required = isPd;
  $('hyStage').required = isPd;
  $('otherConditionText').required = isOther;
  $('otherConditionText').disabled = !isOther;
  if (!isOther) $('otherConditionText').value = '';
  $('yearsDiagnosis').disabled = !isPd;
  $('hyStage').disabled = !isPd;
  document.querySelectorAll('input[name="medications"]').forEach(input => { input.disabled = !isPd; });
}

function enforceExclusiveCheckboxes(name, exclusiveValue) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(input => input.addEventListener('change', () => {
    if (input.value === exclusiveValue && input.checked) {
      document.querySelectorAll(`input[name="${name}"]`).forEach(other => { if (other !== input) other.checked = false; });
    } else if (input.checked) {
      const exclusive = document.querySelector(`input[name="${name}"][value="${exclusiveValue}"]`);
      if (exclusive) exclusive.checked = false;
    }
    if (name === 'tremor_conditions') {
      const otherChecked = Boolean(document.querySelector('input[name="tremor_conditions"][value="other"]:checked'));
      $('otherTremorText').required = otherChecked;
      $('otherTremorText').disabled = !otherChecked;
    }
  }));
}

function validateFeedback() {
  const form = $('feedbackForm');
  setConditionalFields();
  $('healthError').textContent = '';
  $('medicationError').textContent = '';
  $('tremorError').textContent = '';
  let valid = form.checkValidity();
  if (!extractHealthStatus()) {
    $('healthError').textContent = getElementText('validationHealth');
    valid = false;
  }
  if (extractHealthStatus() === 'parkinsons_clinically_diagnosed' && !document.querySelector('input[name="medications"]:checked')) {
    $('medicationError').textContent = getElementText('validationMedication');
    valid = false;
  }
  const tremorValues = [...document.querySelectorAll('input[name="tremor_conditions"]:checked')];
  if (!tremorValues.length) {
    $('tremorError').textContent = getElementText('validationTremor');
    valid = false;
  }
  const otherTremor = document.querySelector('input[name="tremor_conditions"][value="other"]:checked');
  $('otherTremorText').required = Boolean(otherTremor);
  $('otherTremorText').disabled = !otherTremor;
  if (otherTremor && !$('otherTremorText').value.trim()) {
    $('tremorError').textContent = getElementText('validationOther');
    valid = false;
  }
  if (!valid) {
    form.reportValidity();
    ($('healthError').textContent ? document.querySelector('input[name="health_status"]') : form.querySelector(':invalid'))?.focus();
  }
  return valid;
}

function readFeedbackForm() {
  const form = $('feedbackForm');
  const values = new FormData(form);
  const medications = values.getAll('medications');
  const tremors = values.getAll('tremor_conditions');
  return {
    health_status: values.get('health_status'),
    other_neurological_condition: values.get('other_condition') || null,
    years_since_diagnosis: values.has('years_since_diagnosis') ? Number(values.get('years_since_diagnosis')) : null,
    hoehn_yahr_stage: values.has('hoehn_yahr_stage') ? Number(values.get('hoehn_yahr_stage')) || null : null,
    medications: extractHealthStatus() === 'parkinsons_clinically_diagnosed' ? medications : [],
    age_range: values.get('age_range'),
    biological_sex: values.get('biological_sex'),
    handedness: values.get('handedness'),
    dominant_hand_used: values.get('dominant_hand_used') === 'yes',
    tremor_conditions: tremors,
    other_tremor_condition: values.get('other_tremor') || null,
    caffeine_last_2h: values.get('caffeine_last_2h'),
    alcohol_last_4h: values.get('alcohol_last_4h'),
    fatigue_level: Number(values.get('fatigue_level')),
    self_reported_device: values.get('self_reported_device'),
    country: values.get('country')
  };
}

function createConsentPayload() {
  return {
    consent_id: secureUuidV4(),
    device_uuid: deviceUuid,
    consent_version: consentVersion,
    consented_at: new Date().toISOString(),
    age_over_18: true,
    privacy_terms: true,
    research_donation: true,
    no_medical_diagnosis: true,
    locale
  };
}

function createDraftSnapshot() {
  return {
    session_id: sessionId,
    session_metadata: sessionMetadata,
    consent_id: consentId,
    device_uuid: deviceUuid,
    device_fingerprint_hash: deviceFingerprint,
    tasks: taskStates.map(task => ({
      task_id: task.task_id,
      task_version: task.task_version,
      trajectory: task.trajectory,
      canvas_size: task.canvas_size,
      duration_ms: task.duration_ms,
      completed: task.completed,
      skipped: task.skipped,
      v5_inference_result: task.v5_inference_result
    })),
    current_index: activeTaskIndex,
    updated_at: new Date().toISOString()
  };
}

function scheduleDraftSave(immediate = false) {
  if (!consentId || !deviceUuid || sessionQueued) return;
  if (pendingAutosave) {
    if (!immediate) return;
    clearTimeout(pendingAutosave);
  }
  pendingAutosave = setTimeout(() => {
    pendingAutosave = null;
    const snapshot = createDraftSnapshot();
    draftWriteQueue = draftWriteQueue.then(async () => {
      await localStore.saveDraft(snapshot);
      if (currentDraft && currentDraft.session_id !== snapshot.session_id) await localStore.deleteDraft(currentDraft.session_id);
    }).catch(error => {
      $('captureStatus').textContent = `Local draft save failed: ${error.message || 'storage error'}. Do not close this page before retrying.`;
      $('captureStatus').classList.add('error');
    });
  }, immediate ? 0 : 700);
}

async function loadScaler() {
  if (!scalerPromise) scalerPromise = fetch('./scaler_config_v5.json', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error(`Scaler load failed (${response.status}).`);
    const config = await response.json();
    if (!Array.isArray(config.mean) || !Array.isArray(config.scale) || config.mean.length !== 5 || config.scale.length !== 5 || config.scale.some(value => !Number.isFinite(value) || value === 0)) {
      throw new Error('V5 scaler is malformed.');
    }
    return { mean: config.mean, scale: config.scale, threshold: Number(config.classification_threshold ?? 0.5), activation: String(config.output_activation_in_onnx || '') };
  });
  return scalerPromise;
}

async function loadV5Session() {
  if (!modelSessionPromise) modelSessionPromise = (async () => {
    const runtime = globalThis.window?.ort;
    if (!runtime) throw new Error('ONNX Runtime Web is unavailable.');
    ortRuntime = runtime;
    runtime.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
    return runtime.InferenceSession.create('./neurotrace_v5.onnx', { executionProviders: ['wasm'] });
  })().catch(error => { modelSessionPromise = null; throw error; });
  return modelSessionPromise;
}

function modelProbability(output, activation) {
  const values = output?.data ? Array.from(output.data, Number) : [];
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('ONNX returned a non-finite output.');
  if (values.length === 1) {
    const value = values[0];
    return Math.max(0, Math.min(1, activation.includes('raw_logits') || value < 0 || value > 1 ? 1 / (1 + Math.exp(-value)) : value));
  }
  const max = Math.max(...values);
  const exp = values.map(value => Math.exp(value - max));
  return exp[1] / exp.reduce((sum, value) => sum + value, 0);
}

async function inferTask(task) {
  if (task.skipped || task.trajectory.length < 20) return { probability: null, classification: 'unavailable' };
  try {
    const samples = task.trajectory.map(row => ({
      x: row[0], y: row[1], t: row[2] / 1000,
      nativePressure: row[3] === null ? undefined : row[3], pointerType: row[7]
    }));
    const forcePressureProxy = task.pointer_types.size > 0 && [...task.pointer_types].every(type => type === 'mouse');
    const processed = preprocessV5Trial(samples, { forcePressureProxy });
    if (!processed.windows.length) return { probability: null, classification: 'unavailable' };
    const [session, scaler] = await Promise.all([loadV5Session(), loadScaler()]);
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) throw new Error('V5 model input/output not found.');
    const probabilities = [];
    for (const window of processed.windows) {
      const tensorData = standardizeV5Window(window, scaler);
      if (!Array.from(tensorData).every(Number.isFinite)) throw new Error('V5 tensor contains NaN or Infinity.');
      const tensor = new ortRuntime.Tensor('float32', tensorData, [1, 5, 256]);
      const outputs = await session.run({ [inputName]: tensor });
      probabilities.push(modelProbability(outputs[outputName], scaler.activation));
    }
    const probability = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
    return { probability, classification: probability >= scaler.threshold ? 'positive' : 'negative' };
  } catch (error) {
    $('captureStatus').textContent = `${getElementText('inferenceUnavailable')}: ${error.message || 'runtime error'}.`;
    return { probability: null, classification: 'unavailable' };
  }
}

async function finishCurrentTask() {
  if (pointerActive || inferencePending) return;
  const task = taskStates[activeTaskIndex];
  if (!task.trajectory.length) {
    $('captureStatus').textContent = 'Draw a stroke or use Skip this task.';
    $('captureStatus').classList.add('error');
    return;
  }
  inferencePending = true;
  $('nextTask').disabled = true;
  $('captureStatus').textContent = 'Running the existing V5 pipeline where enough signal is available…';
  task.v5_inference_result = await inferTask(task);
  task.completed = true;
  task.skipped = false;
  inferencePending = false;
  $('captureStatus').classList.remove('error');
  $('captureStatus').textContent = getElementText('taskSaved');
  scheduleDraftSave(true);
  if (taskStates.every(item => item.completed || item.skipped)) {
    $('protocol').hidden = true;
    $('feedback').hidden = false;
    $('feedback').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    const next = taskStates.findIndex(item => !item.completed && !item.skipped);
    showTask(next >= 0 ? next : Math.min(activeTaskIndex + 1, 5));
  }
  updateTaskUi();
}

function skipCurrentTask() {
  if (pointerActive || inferencePending) return;
  const state = taskStates[activeTaskIndex];
  state.trajectory = [];
  state.pointer_types.clear();
  state.active_stroke_index = -1;
  state.canvas_size = null;
  state.duration_ms = 0;
  state.started_at_us = null;
  state.ended_at_us = null;
  state.v5_inference_result = { probability: null, classification: 'unavailable' };
  state.completed = true;
  state.skipped = true;
  const stage = canvasElements[activeTaskIndex].parentElement;
  stage.style.width = '';
  stage.style.height = '';
  scheduleRender(activeTaskIndex);
  scheduleDraftSave(true);
  $('captureStatus').textContent = getElementText('taskSkippedStatus');
  if (taskStates.every(item => item.completed || item.skipped)) {
    $('protocol').hidden = true;
    $('feedback').hidden = false;
    $('feedback').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else showTask(taskStates.findIndex(item => !item.completed && !item.skipped));
  updateTaskUi();
}

function buildTaskPayload(task) {
  return {
    task_id: task.task_id,
    task_version: task.task_version,
    duration_ms: task.duration_ms,
    point_count: task.trajectory.length,
    trajectory: task.trajectory,
    canvas_size: task.canvas_size || { w: 0, h: 0 },
    v5_inference_result: task.v5_inference_result,
    skipped: task.skipped
  };
}

function buildSessionPayload(demographics) {
  const tasks = taskStates.map(buildTaskPayload);
  const hasStylus = taskStates.some(task => task.pointer_types.has('pen'));
  const touchCapability = Number(navigator.maxTouchPoints || 0);
  return {
    session_id: sessionId,
    device_uuid: deviceUuid,
    device_fingerprint_hash: deviceFingerprint,
    consent_id: consentId,
    session_metadata: { ...sessionMetadata, timestamp_end: new Date().toISOString(), resumed: Boolean(currentDraft) },
    demographics,
    device_info: {
      userAgent: navigator.userAgent,
      screenWidth: screen.width,
      screenHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      pointerType: lastPointerType,
      hasTouch: touchCapability > 0,
      hasStylus,
      maxTouchPoints: touchCapability,
      estimated_sampling_rate_hz: estimateSampleRate(taskStates)
    },
    tasks,
    client_created_at: new Date().toISOString(),
    schema_version: 'v6.0'
  };
}

async function updatePendingCount() {
  try {
    const count = await localStore.outboxCount();
    $('pendingCount').textContent = getElementText('pendingCount').replace('{count}', String(count));
  } catch (error) {
    $('pendingCount').textContent = `Local queue unavailable: ${error.message || 'storage error'}`;
  }
}

function scheduleRetry(items) {
  if (retryTimer) clearTimeout(retryTimer);
  const dueTimes = items.map(item => item.next_attempt_at || 0).filter(time => time > Date.now());
  if (!dueTimes.length) return;
  retryTimer = setTimeout(() => { void syncOutbox(); }, Math.max(1000, Math.min(...dueTimes) - Date.now()));
}

async function syncOutbox() {
  updateBadge();
  if (!isCollectionConfigured() || !navigator.onLine || syncRunning) {
    await updatePendingCount();
    return;
  }
  syncRunning = true;
  try {
    const items = await localStore.listOutbox();
    const failedConsentIds = new Set();
    for (const item of items) {
      if (item.next_attempt_at > Date.now()) continue;
      if (item.type === 'session' && failedConsentIds.has(item.payload.consent_id)) continue;
      try {
        if (item.type === 'consent') {
          await storeConsent(item.payload);
          try { localStorage.setItem(`neurotrace_synced_consent_${item.payload.consent_id}`, '1'); } catch { /* sync confirmation is best effort */ }
        } else if (item.type === 'session') {
          const consentSynced = readLocalStorage(`neurotrace_synced_consent_${item.payload.consent_id}`) === '1';
          const consentStillQueued = items.some(candidate => candidate.type === 'consent' && candidate.payload.consent_id === item.payload.consent_id);
          if (!consentSynced && consentStillQueued) {
            failedConsentIds.add(item.payload.consent_id);
            continue;
          }
          await storeSession(item.payload);
        }
        await localStore.removeOutbox(item.id);
      } catch (error) {
        if (item.type === 'consent') failedConsentIds.add(item.payload.consent_id);
        const attempts = (item.attempts || 0) + 1;
        const delay = Math.min(MAX_RETRY_MS, 1000 * (2 ** Math.min(attempts, 12)));
        await localStore.updateOutbox({ ...item, attempts, next_attempt_at: Date.now() + delay, last_error: String(error?.message || error).slice(0, 300) });
        $('submissionStatus').textContent = getElementText('syncFailed');
      }
    }
    const remaining = await localStore.listOutbox();
    scheduleRetry(remaining);
    if (!remaining.length) $('submissionStatus').textContent = 'All queued items have synchronized.';
  } catch (error) {
    $('submissionStatus').textContent = `Synchronization unavailable: ${error.message || 'unknown error'}`;
  } finally {
    syncRunning = false;
    await updatePendingCount();
  }
}

function createTaskNavAndFormBehavior() {
  createTaskNav();
  canvasElements.forEach((_, index) => resizeCanvas(index));
  initializePointerCanvases();
  document.querySelectorAll('input[name="health_status"]').forEach(input => input.addEventListener('change', setConditionalFields));
  enforceExclusiveCheckboxes('medications', 'prefer_not_to_say');
  enforceExclusiveCheckboxes('tremor_conditions', 'none');
  $('otherTremorText').disabled = true;
  $('feedbackForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (sessionQueued || !validateFeedback()) return;
    const submitButton = $('submitSession');
    submitButton.disabled = true;
    const priorText = submitButton.textContent;
    submitButton.innerHTML = `<span class="spinner" aria-hidden="true"></span>${getElementText('submitting')}`;
    $('submissionStatus').textContent = '';
    try {
      const payload = buildSessionPayload(readFeedbackForm());
      await draftWriteQueue;
      await localStore.saveDraft(createDraftSnapshot());
      await localStore.enqueue({ id: `session:${sessionId}`, type: 'session', payload, queued_at: new Date().toISOString() });
      sessionQueued = true;
      await localStore.deleteDraft(sessionId).catch(() => {});
      $('feedbackForm').querySelectorAll('input, select, textarea').forEach(control => { control.disabled = true; });
      $('backToTasks').disabled = true;
      $('submissionStatus').textContent = getElementText('submissionDone');
      await updatePendingCount();
      await syncOutbox();
      $('protocol').hidden = true;
      $('feedback').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      $('submissionStatus').textContent = `Could not safely queue this session: ${error.message || 'local storage error'}. Your current form and drawings are still on this page.`;
      $('submissionStatus').classList.add('error');
    } finally {
      submitButton.disabled = sessionQueued;
      submitButton.textContent = priorText;
    }
  });
  $('fatigue').addEventListener('input', () => { $('fatigueValue').value = $('fatigue').value; $('fatigueValue').textContent = $('fatigue').value; });
  $('backToTasks').addEventListener('click', () => showTask(Math.max(0, taskStates.findIndex(task => !task.completed && !task.skipped))));
  $('nextTask').addEventListener('click', () => { void finishCurrentTask(); });
  $('skipTask').addEventListener('click', skipCurrentTask);
  $('redoTask').addEventListener('click', resetCurrentTask);
  $('previousTask').addEventListener('click', () => showTask(activeTaskIndex - 1));
  $('syncNow').addEventListener('click', () => { void syncOutbox(); });
  $('contrastToggle').addEventListener('click', () => {
    document.body.classList.toggle('high-contrast');
    writeLocalStorage('neurotrace_v6_high_contrast', document.body.classList.contains('high-contrast') ? '1' : '0');
  });
  $('languageSelect').addEventListener('change', async event => {
    try {
      const language = event.target.value === 'vi' ? 'vi' : 'en';
      if (!i18n[language].pageTitle) await loadTranslations(language);
      applyLanguage(language);
      writeLocalStorage('neurotrace_v6_locale', language);
    } catch (error) { $('captureStatus').textContent = `Translation load failed: ${error.message || 'network error'}`; }
  });
  $('resetId').addEventListener('click', () => {
    if (!confirm(getElementText('confirmReset'))) return;
    FINGERPRINT_KEYS.forEach(key => { try { localStorage.removeItem(key); } catch { /* no-op */ } });
    location.reload();
  });
  $('clearPending').addEventListener('click', async () => {
    if (!confirm(getElementText('confirmClear'))) return;
    try {
      await localStore.clearOutbox();
      await updatePendingCount();
      $('submissionStatus').textContent = 'Unsent local drafts and queue items were cleared from this browser.';
    } catch (error) { $('submissionStatus').textContent = `Could not clear local data: ${error.message || 'storage error'}`; }
  });
  window.addEventListener('online', () => { updateBadge(); void syncOutbox(); });
  window.addEventListener('offline', updateBadge);
  window.addEventListener('pagehide', () => { if (pointerActive) scheduleDraftSave(true); });
}

function showFirstTask() {
  $('resumePanel').hidden = true;
  $('protocol').hidden = false;
  $('feedback').hidden = true;
  activeTaskIndex = Math.min(activeTaskIndex, 5);
  configureTemplates();
  updateTaskUi();
  panels[activeTaskIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
  scheduleDraftSave(true);
}

function applyDraft(draft) {
  if (!draft || !Array.isArray(draft.tasks) || draft.tasks.length !== 6) throw new Error('Saved session draft is incomplete.');
  currentDraft = draft;
  sessionMetadata = { ...sessionMetadata, resumed_from_session_id: draft.session_id, resumed_at: new Date().toISOString() };
  // Keep this page-load UUID and the fresh consent; the unfinished local trajectories are rebased into this session.
  activeTaskIndex = Number.isInteger(draft.current_index) ? Math.max(0, Math.min(5, draft.current_index)) : 0;
  draft.tasks.forEach((saved, index) => {
    const state = taskStates[index];
    state.trajectory = Array.isArray(saved.trajectory) ? saved.trajectory : [];
    state.canvas_size = saved.canvas_size || null;
    state.duration_ms = Number(saved.duration_ms || 0);
    state.completed = Boolean(saved.completed);
    state.skipped = Boolean(saved.skipped);
    state.started_at_us = state.trajectory.length ? state.trajectory[0][2] : null;
    state.ended_at_us = state.trajectory.length ? state.trajectory[state.trajectory.length - 1][2] : null;
    state.pointer_types = new Set(state.trajectory.map(row => row[7]).filter(Boolean));
    state.active_stroke_index = state.trajectory.reduce((max, row) => Math.max(max, Number(row[13] ?? 0)), -1);
    state.v5_inference_result = saved.v5_inference_result || { probability: null, classification: 'unavailable' };
    if (state.canvas_size) {
      const stage = canvasElements[index].parentElement;
      stage.style.width = `${state.canvas_size.w}px`;
      stage.style.height = `${state.canvas_size.h}px`;
    }
  });
  return showFirstTask();
}

function showDraftChooser() {
  availableDrafts = availableDrafts.filter(draft => draft?.session_id && Array.isArray(draft.tasks));
  if (!availableDrafts.length) return showFirstTask();
  currentDraftIndex = 0;
  updateDraftChooser();
}

function updateDraftChooser() {
  if (currentDraftIndex >= availableDrafts.length) return showFirstTask();
  const draft = availableDrafts[currentDraftIndex];
  $('resumePanel').hidden = false;
  $('protocol').hidden = true;
  $('feedback').hidden = true;
  $('resumeText').textContent = `An unfinished local session from ${new Date(draft.updated_at || draft.session_metadata?.timestamp_start || Date.now()).toLocaleString(locale)} has ${draft.tasks.filter(task => task.completed || task.skipped).length} completed or skipped tasks.`;
  $('resumeDraft').onclick = () => {
    if (draft.device_uuid && draft.device_uuid !== deviceUuid) {
      $('resumeText').textContent = 'This draft belongs to a different local identifier and cannot be resumed under the current browser ID.';
      return;
    }
    try { applyDraft(draft); } catch (error) { $('resumeText').textContent = error.message; }
  };
  $('discardDraft').onclick = async () => {
    await localStore.deleteDraft(draft.session_id);
    currentDraftIndex++;
    updateDraftChooser();
  };
  $('startNewSession').onclick = showFirstTask;
}

async function acceptConsent(event) {
  event.preventDefault();
  const form = $('consentForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const button = $('acceptConsent');
  button.disabled = true;
  $('consentError').textContent = getElementText('preparingConsent');
  try {
    const identity = await getOrCreateIdentity();
    deviceUuid = identity.uuid;
    deviceFingerprint = identity.fingerprint;
    sessionMetadata = {
      timestamp_start: sessionStartedAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
      locale: navigator.language || locale
    };
    const consent = createConsentPayload();
    consentId = consent.consent_id;
    await localStore.enqueue({ id: `consent:${consent.consent_id}`, type: 'consent', payload: consent, queued_at: consent.consented_at });
    $('consentDialog').close();
    $('collectionApp').hidden = false;
    $('moduleFallback').hidden = true;
    $('contactGate').textContent = isCollectionConfigured() ? '' : getElementText('privacyDraft');
    await updatePendingCount();
    await showDraftsAfterConsent();
    if (isCollectionConfigured()) {
      void initializeAnalyticsAfterConsent();
      void syncOutbox();
    }
  } catch (error) {
    $('consentError').textContent = `Could not initialize secure local collection: ${error.message || 'storage error'}. No drawing has started.`;
    button.disabled = false;
  }
}

async function showDraftsAfterConsent() {
  try {
    availableDrafts = await localStore.listDrafts();
    showDraftChooser();
  } catch (error) {
    $('captureStatus').textContent = `Could not inspect local drafts: ${error.message || 'storage error'}`;
    showFirstTask();
  }
}

async function initialize() {
  try {
    sessionId = secureUuidV4();
    sessionStartedAt = new Date().toISOString();
    const preferredLocale = readLocalStorage('neurotrace_v6_locale');
    locale = preferredLocale === 'vi' ? 'vi' : 'en';
    $('languageSelect').value = locale;
    await loadTranslations('en');
    await loadTranslations('vi');
    applyLanguage(locale);
    if (readLocalStorage('neurotrace_v6_high_contrast') === '1') document.body.classList.add('high-contrast');
    configureTemplates();
    createTaskNavAndFormBehavior();
    await localStore.listOutbox();
    await localStore.listDrafts();
    $('collectionApp').hidden = false;
    $('moduleFallback').hidden = true;
    updateBadge();
    $('contactGate').textContent = isCollectionConfigured() ? '' : getElementText('privacyDraft');
    $('consentForm').addEventListener('submit', event => { void acceptConsent(event); });
    $('consentForm').addEventListener('change', () => {
      $('acceptConsent').disabled = !$('consentForm').checkValidity();
    });
    $('acceptConsent').disabled = true;
    $('previousTask').disabled = true;
    await updatePendingCount();
    if (isCollectionConfigured()) void syncOutbox();
    $('consentDialog').showModal();
  } catch (error) {
    $('moduleFallback').hidden = false;
    $('moduleFallback').textContent = `Collection is unavailable: ${error.message || 'secure browser storage is required'}. V5 inference remains available from the main page.`;
  }
}

initialize();
