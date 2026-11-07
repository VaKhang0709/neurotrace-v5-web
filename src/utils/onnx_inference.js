import {
  V6_FEATURE_CONTRACT,
  V6_FEATURE_NAMES,
  extractV6FeatureWindows,
  mapDeviceDomain
} from './v6_feature_extractor.js';

export const V6_MODEL_TIERS = Object.freeze({
  nano: Object.freeze({
    file: 'neurotrace_v6_nano.onnx',
    url: '/models/v6/neurotrace_v6_nano.onnx',
    sha256: '38ab0ae21b78085e3bf9c80618719e33f2fb790678a8f97d0ab9f3e198cb8f09',
    precision: 'INT8',
    bytes: 1370917
  }),
  base: Object.freeze({
    file: 'neurotrace_v6_base.onnx',
    url: '/models/v6/neurotrace_v6_base.onnx',
    sha256: '9e89ce556808f5aa9aa3d36ad19989099cecb0f7db44ddf3d2a518e9ac2d6ce8',
    precision: 'FP16',
    bytes: 7426918
  }),
  pro: Object.freeze({
    file: 'neurotrace_v6_pro.onnx',
    url: '/models/v6/neurotrace_v6_pro.onnx',
    sha256: '1b69d67c13baa772fc020401d687c133634125d868ce01d136bf1db852419e9e',
    precision: 'FP32',
    bytes: 63112269
  })
});
export const V6_SCALER_URL = '/models/v6/scaler_config_v6.json';
export const V6_FAMILY_VERSION = 'v6-family-1';
const V6_CACHE_NAME = 'neurotrace-v6-family-1';
const EXPECTED_PRO_SHA256 = V6_MODEL_TIERS.pro.sha256;
const modelPromises = new Map();
let scalerPromise;
let scalerFetchDurationMs = null;

async function cachedResponse(url, fetcher, options = {}) {
  let cache = null;
  try { if (globalThis.caches?.open) cache = await globalThis.caches.open(V6_CACHE_NAME); } catch { /* Cache API is optional. */ }
  if (cache) {
    try {
      const cached = await cache.match(url);
      if (cached) return { response: cached, cache, fromCache: true };
    } catch { /* Fall through to fetch. */ }
  }
  const response = await fetcher(url, options);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  if (cache) {
    try { await cache.put(url, response.clone()); } catch { /* Storage quota/private mode; use this response. */ }
  }
  return { response, cache, fromCache: false };
}

/** Load and validate the shipped V6 feature/scaler contract, with offline cache support. */
export async function loadV6Scaler(fetcher = globalThis.fetch) {
  if (!scalerPromise) {
    scalerPromise = (async () => {
      const started = globalThis.performance?.now?.() ?? Date.now();
      const { response } = await cachedResponse(V6_SCALER_URL, fetcher, { cache: 'force-cache' });
      const config = await response.json();
      validateV6Scaler(config);
      scalerFetchDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - started;
      return config;
    })().catch(error => {
      scalerPromise = null;
      throw error;
    });
  }
  return scalerPromise;
}

/** Reject scaler files whose declared contract differs from the exported model family contract. */
export function validateV6Scaler(config) {
  if (!config || config.feature_contract !== V6_FEATURE_CONTRACT) {
    throw new Error(`Expected feature contract ${V6_FEATURE_CONTRACT}.`);
  }
  if (!Array.isArray(config.feature_names) || config.feature_names.length !== 19
    || config.feature_names.some((name, index) => name !== V6_FEATURE_NAMES[index])) {
    throw new Error('V6 scaler feature_names do not match the 19-channel frontend contract.');
  }
  if (!Array.isArray(config.mean) || !Array.isArray(config.scale)
    || config.mean.length !== 19 || config.scale.length !== 19
    || config.scale.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('V6 scaler diagnostic mean/scale must contain 19 finite channels.');
  }
  if (config.reference_sequence_length !== 512
    || Number(config.minimum_engineering_sequence_length) < 64
    || Number(config.canonical_rate_hz) !== 100) {
    throw new Error('V6 scaler sequence-length or canonical-rate contract is unsupported.');
  }
  if (config.apply_global_standardization !== false
    || config.normalization?.type !== 'per_window_population_zscore'
    || Number(config.normalization?.epsilon) !== 1e-6
    || (config.normalization?.exempt_channels || []).length !== 0) {
    throw new Error('V6 normalization contract mismatch; refusing to apply unintended transforms.');
  }
  if (Number(config.classification_threshold) !== 0.5 || config.threshold_policy !== 'fixed_0.5') {
    throw new Error('V6 fixed 0.50 threshold contract is unsupported.');
  }
  if (config.parity?.passed !== true || config.parity?.dynamic_sequence !== true
    || config.parity?.onnx_sha256 !== EXPECTED_PRO_SHA256) {
    throw new Error('V6 PRO parity manifest does not match the expected family artifact.');
  }
  if (config.output_semantics !== 'raw_logits') {
    throw new Error('V6 model output semantics are not declared as raw logits.');
  }
  return config;
}

export function selectV6ModelTier({ mode = 'auto', online = true, connection = null, latencyMs = null } = {}) {
  if (mode === 'nano') return { tier: 'nano', reason: 'explicit_nano_mode' };
  if (online === false) return { tier: 'nano', reason: 'offline' };
  if (mode === 'base') return { tier: 'base', reason: 'explicit_base_mode' };
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  if (['slow-2g', '2g', '3g'].includes(effectiveType)
    || (Number.isFinite(Number(connection?.downlink)) && Number(connection.downlink) > 0 && Number(connection.downlink) < 1)
    || (Number.isFinite(Number(connection?.rtt)) && Number(connection.rtt) >= 800)
    || (Number.isFinite(Number(latencyMs)) && Number(latencyMs) >= 1200)) {
    return { tier: 'nano', reason: 'low_bandwidth_or_high_latency' };
  }
  return { tier: 'base', reason: 'online_default' };
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required to verify V6 model assets.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function loadModelBytes(tier, fetcher) {
  const metadata = V6_MODEL_TIERS[tier];
  let result;
  try {
    result = await cachedResponse(metadata.url, fetcher, { cache: 'force-cache' });
  } catch (error) {
    throw new Error(`Could not load V6 ${tier.toUpperCase()} model: ${error.message || 'network error'}`);
  }
  let bytes = new Uint8Array(await result.response.arrayBuffer());
  let actual = await sha256Hex(bytes);
  if (actual !== metadata.sha256 && result.fromCache && result.cache) {
    try { await result.cache.delete(metadata.url); } catch { /* Ignore cache cleanup errors. */ }
    result = await cachedResponse(metadata.url, fetcher, { cache: 'reload' });
    bytes = new Uint8Array(await result.response.arrayBuffer());
    actual = await sha256Hex(bytes);
  }
  if (actual !== metadata.sha256) throw new Error(`V6 ${tier.toUpperCase()} SHA-256 mismatch; refusing unverified model bytes.`);
  return bytes;
}

/** Load an integrity-checked tier session; CacheStorage plus the in-memory session map support repeat/offline use. */
export async function loadV6Model(runtime = globalThis.window?.ort, tier = 'base', fetcher = globalThis.fetch, bytesLoader = loadModelBytes) {
  if (!runtime?.InferenceSession || !runtime?.Tensor) {
    throw new Error('ONNX Runtime Web is not available in this browser.');
  }
  if (!V6_MODEL_TIERS[tier] || tier === 'pro') throw new Error('PRO is server-side only and cannot be loaded by the client.');
  if (runtime.env?.wasm && !runtime.env.wasm.wasmPaths) {
    runtime.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
  }
  if (!modelPromises.has(tier)) {
    const promise = bytesLoader(tier, fetcher).then(bytes => runtime.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    })).then(session => {
      const inputs = new Set(session.inputNames || []);
      if (!inputs.has('trajectory') || !inputs.has('device_id')) {
        throw new Error(`V6 ${tier.toUpperCase()} ONNX inputs differ from trajectory + device_id contract.`);
      }
      if (!(session.outputNames || []).includes('logits')) {
        throw new Error(`V6 ${tier.toUpperCase()} ONNX logits output is unavailable.`);
      }
      return { session, runtime, tier };
    }).catch(error => {
      modelPromises.delete(tier);
      throw new Error(`Could not load V6 ${tier.toUpperCase()} model: ${error?.message || 'runtime error'}`);
    });
    modelPromises.set(tier, promise);
  }
  return modelPromises.get(tier);
}

/** Population z-score each channel within a window, matching v6-dwt19-v1. */
export function normalizeV6Window(window, epsilon = 1e-6) {
  if (!Array.isArray(window) || window.length !== 19 || !window[0]?.length
    || window.some(channel => channel.length !== window[0].length)) {
    throw new Error('Expected a rectangular V6 [19, time] feature window.');
  }
  return window.map((channel, channelIndex) => {
    let mean = 0;
    for (const value of channel) {
      if (!Number.isFinite(value)) throw new Error(`Non-finite value in V6 feature channel ${channelIndex}.`);
      mean += value;
    }
    mean /= channel.length;
    let variance = 0;
    for (const value of channel) variance += (value - mean) ** 2;
    const standardDeviation = Math.sqrt(variance / channel.length);
    const denominator = Math.max(standardDeviation, epsilon);
    return channel.map(value => (value - mean) / denominator);
  });
}

function flattenChannels(channels) {
  const timeLength = channels[0].length;
  const tensor = new Float32Array(19 * timeLength);
  for (let channel = 0; channel < 19; channel++) {
    for (let t = 0; t < timeLength; t++) {
      const value = channels[channel][t];
      if (!Number.isFinite(value)) throw new Error(`Non-finite V6 tensor value at channel ${channel}, time ${t}.`);
      tensor[channel * timeLength + t] = value;
    }
  }
  return tensor;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

async function inferWindow(window, deviceId, runtime, session) {
  // extractV6FeatureWindows has already applied the contract's per-window z-score once.
  const timeLength = window[0].length;
  const trajectoryTensor = new runtime.Tensor('float32', flattenChannels(window), [1, 19, timeLength]);
  const deviceTensor = new runtime.Tensor('int64', BigInt64Array.of(BigInt(deviceId)), [1]);
  const output = await session.run({ trajectory: trajectoryTensor, device_id: deviceTensor });
  const logits = output.logits?.data;
  if (!logits || !Number.isFinite(Number(logits[0]))) throw new Error('V6 ONNX returned no finite logit.');
  return { logit: Number(logits[0]), probability: sigmoid(Number(logits[0])), sequenceLength: timeLength };
}

function defaultDeviceCutoffs(scaler) {
  return scaler.device_filter_cutoff_hz || { wacom: 15, touch: 10, mouse: 12, stylus: 15, unknown: 10 };
}

/**
 * Run V6 feature extraction and ONNX inference for the completed task set.
 * The model's only output is `logits`; no calibrated domain-confidence head is
 * present, so domain_confidence is explicitly null rather than fabricated.
 * @param {Array<{task_id:string,trajectory:Array,skipped?:boolean,pointer_types?:Set|string[]}>} tasks Completed tasks.
 * @param {{deviceSelfReported?:string,runtime?:object,fetcher?:Function}} options Inference dependencies and device hint.
 */
export async function runV6Assessment(tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length !== 6) throw new Error('V6 assessment requires exactly six task records.');
  const scaler = await loadV6Scaler(options.fetcher || globalThis.fetch);
  const mode = options.tierMode || 'auto';
  const connection = options.connection || globalThis.navigator?.connection || null;
  const selection = selectV6ModelTier({
    mode,
    online: options.online ?? globalThis.navigator?.onLine ?? true,
    connection,
    latencyMs: options.networkLatencyMs ?? scalerFetchDurationMs
  });
  let selectedTier = selection.tier;
  let fallbackReason = null;
  let model;
  try {
    model = await loadV6Model(options.runtime || globalThis.window?.ort, selectedTier, options.modelFetcher || options.fetcher || globalThis.fetch, options.modelBytesLoader || loadModelBytes);
  } catch (error) {
    if (mode !== 'auto' || selectedTier !== 'base') throw error;
    fallbackReason = 'base_load_failed';
    selectedTier = 'nano';
    model = await loadV6Model(options.runtime || globalThis.window?.ort, selectedTier, options.modelFetcher || options.fetcher || globalThis.fetch, options.modelBytesLoader || loadModelBytes);
  }
  const pointerTypes = new Set();
  for (const task of tasks) {
    const observed = task.pointer_types instanceof Set ? task.pointer_types : new Set(task.pointer_types || []);
    for (const type of observed) pointerTypes.add(type);
    for (const row of task.trajectory || []) if (Array.isArray(row) && row[7]) pointerTypes.add(row[7]);
  }
  const domain = mapDeviceDomain(pointerTypes, options.deviceSelfReported, scaler.device_embedding_lookup);
  const results = [];
  for (const task of tasks) {
    if (task.skipped || !Array.isArray(task.trajectory) || task.trajectory.length < 2) {
      results.push({ task_id: task.task_id, skipped: Boolean(task.skipped), probability: null, window_probabilities: [], status: 'unavailable' });
      continue;
    }
    const extracted = extractV6FeatureWindows(task.trajectory, {
      sampleRateHz: scaler.canonical_rate_hz,
      deviceType: domain.domain,
      deviceCutoffs: defaultDeviceCutoffs(scaler)
    });
    if (!extracted.windows.length) {
      results.push({ task_id: task.task_id, skipped: false, probability: null, window_probabilities: [], status: 'insufficient_signal', diagnostics: extracted.diagnostics });
      continue;
    }
    const windowOutputs = [];
    for (const window of extracted.windows) windowOutputs.push(await inferWindow(window, domain.deviceId, model.runtime, model.session));
    const probability = windowOutputs.reduce((sum, item) => sum + item.probability, 0) / windowOutputs.length;
    results.push({
      task_id: task.task_id,
      skipped: false,
      probability,
      window_probabilities: windowOutputs.map(item => item.probability),
      window_logits: windowOutputs.map(item => item.logit),
      sequence_lengths: windowOutputs.map(item => item.sequenceLength),
      status: 'complete',
      diagnostics: extracted.diagnostics
    });
  }
  const scoredTasks = results.filter(item => item.status === 'complete');
  const rawProbability = scoredTasks.length
    ? scoredTasks.reduce((sum, item) => sum + item.probability, 0) / scoredTasks.length
    : null;
  return {
    model_family: V6_FAMILY_VERSION,
    model_version: scaler.version,
    model_tier: selectedTier,
    model_precision: V6_MODEL_TIERS[selectedTier].precision,
    model_file: V6_MODEL_TIERS[selectedTier].file,
    model_sha256_expected: V6_MODEL_TIERS[selectedTier].sha256,
    model_selection_reason: fallbackReason || selection.reason,
    feature_contract: scaler.feature_contract,
    output_semantics: 'raw_logits_sigmoid',
    threshold: Number(scaler.classification_threshold ?? 0.5),
    raw_probability: rawProbability,
    calibrated_probability: null,
    calibration_scope: 'not_applied_to_v6_family_tiers',
    calibration_warning: null,
    scored_task_count: scoredTasks.length,
    task_results: results,
    device_self_reported: options.deviceSelfReported || null,
    device_domain: domain.domain,
    device_id: domain.deviceId,
    domain_confidence: null,
    domain_confidence_reason: 'The exported ONNX graph returns logits only; it has no domain-confidence output head.',
    clinical_validation: scaler.clinical_validation || 'NOT_ESTABLISHED'
  };
}
