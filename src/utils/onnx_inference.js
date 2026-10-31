import {
  V6_FEATURE_CONTRACT,
  V6_FEATURE_NAMES,
  extractV6FeatureWindows,
  mapDeviceDomain
} from './v6_feature_extractor.js';

export const V6_MODEL_URL = '/models/v6/neurotrace_v6_tremorformer.onnx';
export const V6_SCALER_URL = '/models/v6/scaler_config_v6.json';
const EXPECTED_MODEL_SHA256 = '0593c9c17470f7868f70aa2bc5de6fa51e2dfb27d067bfd15c83648cf28424b4';
let modelPromise;
let scalerPromise;

/** Load and validate the shipped V6 feature/scaler contract. */
export async function loadV6Scaler(fetcher = globalThis.fetch) {
  if (!scalerPromise) {
    scalerPromise = (async () => {
      const response = await fetcher(V6_SCALER_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load V6 scaler (${response.status}).`);
      const config = await response.json();
      validateV6Scaler(config);
      return config;
    })().catch(error => {
      scalerPromise = null;
      throw error;
    });
  }
  return scalerPromise;
}

/** Reject scaler files whose declared contract differs from the exported model contract. */
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
    || config.parity?.onnx_sha256 !== EXPECTED_MODEL_SHA256) {
    throw new Error('V6 ONNX parity manifest does not match the expected exported model.');
  }
  if (config.output_semantics !== 'raw_logits') {
    throw new Error('V6 model output semantics are not declared as raw logits.');
  }
  return config;
}

/** Load ONNX Runtime Web and the selected-member V6 TremorFormer session. */
export async function loadV6Model(runtime = globalThis.window?.ort) {
  if (!runtime?.InferenceSession || !runtime?.Tensor) {
    throw new Error('ONNX Runtime Web is not available in this browser.');
  }
  if (!modelPromise) {
    if (runtime.env?.wasm && !runtime.env.wasm.wasmPaths) {
      runtime.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
    }
    modelPromise = runtime.InferenceSession.create(V6_MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    }).then(session => {
      const inputs = new Set(session.inputNames || []);
      if (!inputs.has('trajectory') || !inputs.has('device_id')) {
        throw new Error('V6 ONNX inputs differ from trajectory + device_id contract.');
      }
      if (!(session.outputNames || []).includes('logits')) {
        throw new Error('V6 ONNX logits output is unavailable.');
      }
      return { session, runtime };
    }).catch(error => {
      modelPromise = null;
      throw new Error(`Could not load V6 ONNX model: ${error?.message || 'runtime error'}`);
    });
  }
  return modelPromise;
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

function calibratedProbability(probability, calibration) {
  const x = calibration?.x, y = calibration?.y;
  if (!Array.isArray(x) || !Array.isArray(y) || x.length < 2 || x.length !== y.length) return null;
  if (probability <= x[0]) return y[0];
  if (probability >= x[x.length - 1]) return y[y.length - 1];
  for (let i = 1; i < x.length; i++) {
    if (probability <= x[i]) {
      const span = x[i] - x[i - 1];
      const fraction = span > 0 ? (probability - x[i - 1]) / span : 0;
      return y[i - 1] + fraction * (y[i] - y[i - 1]);
    }
  }
  return y[y.length - 1];
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
  const [scaler, model] = await Promise.all([
    loadV6Scaler(options.fetcher || globalThis.fetch),
    loadV6Model(options.runtime || globalThis.window?.ort)
  ]);
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
  const calibrated = rawProbability === null ? null : calibratedProbability(rawProbability, scaler.calibration);
  return {
    model_version: scaler.version,
    feature_contract: scaler.feature_contract,
    model_sha256_expected: scaler.parity?.onnx_sha256 || EXPECTED_MODEL_SHA256,
    output_semantics: 'raw_logits_sigmoid',
    threshold: Number(scaler.classification_threshold ?? 0.5),
    raw_probability: rawProbability,
    calibrated_probability: calibrated,
    calibration_scope: scaler.calibration_scope || null,
    calibration_warning: scaler.calibration?.warning || null,
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
