/**
 * TremorFormer V6 client-side feature pipeline for contract v6-dwt19-v1.
 *
 * IMPORTANT: The channel order and per-window normalization are read from the
 * exported scaler contract. This module deliberately does not apply the
 * scaler's train-only diagnostic mean/std a second time.
 */
export const V6_FEATURE_NAMES = Object.freeze([
  'x', 'y', 'pressure', 'vx', 'vy', 'speed', 'ax', 'ay', 'acceleration',
  'jerk', 'curvature', 'pressure_derivative', 'azimuth_derivative',
  'wavelet_db4_l1', 'wavelet_db4_l2', 'wavelet_db4_l3', 'wavelet_db4_l4',
  'wavelet_db4_l5', 'v5_proxy_p'
]);
export const V6_FEATURE_CONTRACT = 'v6-dwt19-v1';
export const V6_CANONICAL_RATE_HZ = 100;
export const V6_WINDOW_SIZE = 512;
export const V6_WINDOW_STRIDE = 256;
export const V6_MIN_SEQUENCE_LENGTH = 64;
const EPSILON = 1e-6;

const DB4_LOW = [
  -0.010597401785069032, 0.0328830116668852, 0.030841381835560764,
  -0.18703481171888114, -0.02798376941685985, 0.6308807679298587,
  0.7148465705529154, 0.2303778133088964
];
const DB4_HIGH = [
  -0.2303778133088964, 0.7148465705529154, -0.6308807679298587,
  -0.18703481171888114, 0.02798376941685985, 0.030841381835560764,
  -0.0328830116668852, -0.010597401785069032
];
const BUTTERWORTH_Q = [0.541196100146197, 1.306562964876377];

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPoint(point, index) {
  if (Array.isArray(point)) {
    const timestampUs = finite(point[2]);
    return {
      x: finite(point[0]), y: finite(point[1]),
      timeMs: timestampUs === null ? null : timestampUs / 1000,
      pressure: finite(point[3]), tiltX: finite(point[4]), tiltY: finite(point[5]),
      pointerType: typeof point[7] === 'string' ? point[7] : 'unknown',
      strokeIndex: Number.isFinite(Number(point[13])) ? Number(point[13]) : 0,
      originalIndex: index
    };
  }
  const timestampMs = finite(point?.timeMs ?? point?.t ?? point?.timestamp_ms);
  const timestampUs = finite(point?.timestamp_us ?? point?.timestampUs);
  return {
    x: finite(point?.x), y: finite(point?.y),
    timeMs: timestampUs !== null ? timestampUs / 1000 : timestampMs,
    pressure: finite(point?.pressure ?? point?.nativePressure),
    tiltX: finite(point?.tiltX), tiltY: finite(point?.tiltY),
    pointerType: typeof point?.pointerType === 'string' ? point.pointerType : 'unknown',
    strokeIndex: Number.isFinite(Number(point?.strokeIndex)) ? Number(point.strokeIndex) : 0,
    originalIndex: index
  };
}

function interpolate(values, position) {
  if (values.length === 1) return values[0];
  const left = Math.max(0, Math.min(values.length - 1, Math.floor(position)));
  const right = Math.min(left + 1, values.length - 1);
  const alpha = Math.max(0, Math.min(1, position - left));
  return values[left] + (values[right] - values[left]) * alpha;
}

function interpolatePoint(points, left, timeMs, key, fallback = 0) {
  const right = Math.min(left + 1, points.length - 1);
  const span = points[right].timeMs - points[left].timeMs;
  const alpha = span > 0 ? (timeMs - points[left].timeMs) / span : 0;
  const a = finite(points[left][key]);
  const b = finite(points[right][key]);
  if (a === null && b === null) return fallback;
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * alpha;
}

function resampleStroke(points, sampleRateHz) {
  const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs || a.originalIndex - b.originalIndex);
  const deduplicated = [];
  for (const point of sorted) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.timeMs)) continue;
    if (deduplicated.length && point.timeMs <= deduplicated[deduplicated.length - 1].timeMs) continue;
    deduplicated.push(point);
  }
  if (deduplicated.length < 2) return [];
  const intervalMs = 1000 / sampleRateHz;
  const start = deduplicated[0].timeMs;
  const end = deduplicated[deduplicated.length - 1].timeMs;
  const count = Math.floor((end - start) / intervalMs) + 1;
  if (count < 2 || count > sampleRateHz * 120) return [];
  const result = [];
  let right = 1;
  for (let i = 0; i < count; i++) {
    const timeMs = start + i * intervalMs;
    while (right < deduplicated.length - 1 && deduplicated[right].timeMs < timeMs) right++;
    const left = Math.max(0, right - 1);
    const nearest = timeMs >= deduplicated[right].timeMs ? deduplicated[right] : deduplicated[left];
    result.push({
      x: interpolatePoint(deduplicated, left, timeMs, 'x'),
      y: interpolatePoint(deduplicated, left, timeMs, 'y'),
      pressure: interpolatePoint(deduplicated, left, timeMs, 'pressure', NaN),
      tiltX: interpolatePoint(deduplicated, left, timeMs, 'tiltX', 0),
      tiltY: interpolatePoint(deduplicated, left, timeMs, 'tiltY', 0),
      pointerType: nearest.pointerType,
      strokeIndex: nearest.strokeIndex
    });
  }
  return result;
}

function derivative(values, secondsPerSample) {
  if (values.length < 2) return values.map(() => 0);
  const out = new Array(values.length);
  out[0] = (values[1] - values[0]) / secondsPerSample;
  for (let i = 1; i < values.length - 1; i++) {
    out[i] = (values[i + 1] - values[i - 1]) / (2 * secondsPerSample);
  }
  out[out.length - 1] = (values[out.length - 1] - values[out.length - 2]) / secondsPerSample;
  return out.map(value => Number.isFinite(value) ? value : 0);
}

function biquadCascade(values, cutoffHz, sampleRateHz) {
  const k = Math.tan(Math.PI * cutoffHz / sampleRateHz);
  let result = [...values];
  for (const q of BUTTERWORTH_Q) {
    const norm = 1 / (1 + k / q + k * k);
    const b0 = k * k * norm, b1 = 2 * b0, b2 = b0;
    const a1 = 2 * (k * k - 1) * norm;
    const a2 = (1 - k / q + k * k) * norm;
    const output = new Array(result.length);
    let x1 = result[0] || 0, x2 = x1, y1 = x1, y2 = x1;
    for (let i = 0; i < result.length; i++) {
      const x0 = result[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      output[i] = Number.isFinite(y0) ? y0 : 0;
      x2 = x1; x1 = x0; y2 = y1; y1 = output[i];
    }
    result = output;
  }
  return result;
}

/** Fourth-order Butterworth low-pass using forward/backward filtering. */
export function butterworthLowPass(values, cutoffHz = 12, sampleRateHz = V6_CANONICAL_RATE_HZ) {
  if (!Array.isArray(values) || values.length < 3) return [...(values || [])];
  const cutoff = Math.max(0.1, Math.min(cutoffHz, sampleRateHz * 0.45));
  const pad = Math.min(15, values.length - 1);
  const left = [], right = [];
  for (let i = pad; i >= 1; i--) left.push(2 * values[0] - values[i]);
  for (let i = 2; i <= pad + 1; i++) right.push(2 * values.at(-1) - values[values.length - i]);
  const padded = [...left, ...values, ...right];
  const forward = biquadCascade(padded, cutoff, sampleRateHz);
  const reversed = biquadCascade(forward.reverse(), cutoff, sampleRateHz).reverse();
  return reversed.slice(pad, pad + values.length);
}

function symmetricIndex(index, length) {
  if (length <= 1) return 0;
  let value = index;
  while (value < 0 || value >= length) {
    if (value < 0) value = -value - 1;
    if (value >= length) value = 2 * length - value - 1;
  }
  return value;
}

function downsampleFilter(values, filter) {
  const out = new Array(Math.ceil(values.length / 2));
  const offset = Math.floor(filter.length / 2) - 1;
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = 0; k < filter.length; k++) {
      sum += filter[k] * values[symmetricIndex(2 * i + k - offset, values.length)];
    }
    out[i] = Number.isFinite(sum) ? sum : 0;
  }
  return out;
}

function waveletDetailsDb4(values, levels = 5) {
  let approximation = [...values];
  const details = [];
  for (let level = 0; level < levels; level++) {
    if (approximation.length < 2) {
      details.push(new Array(values.length).fill(0));
      continue;
    }
    const detail = downsampleFilter(approximation, DB4_HIGH);
    approximation = downsampleFilter(approximation, DB4_LOW);
    const scale = 2 ** (level + 1);
    details.push(values.map((_, i) => interpolate(detail, i / scale)));
  }
  return details;
}

function median(values) {
  const finiteValues = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finiteValues.length) return 0;
  const m = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2 ? finiteValues[m] : (finiteValues[m - 1] + finiteValues[m]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function deriveBlock(samples, cutoffHz, sampleRateHz) {
  const dt = 1 / sampleRateHz;
  const rawX = samples.map(point => point.x);
  const rawY = samples.map(point => point.y);
  const x = butterworthLowPass(rawX, cutoffHz, sampleRateHz);
  const y = butterworthLowPass(rawY, cutoffHz, sampleRateHz);
  const vx = derivative(x, dt), vy = derivative(y, dt);
  const speed = vx.map((value, i) => Math.hypot(value, vy[i]));
  const ax = derivative(vx, dt), ay = derivative(vy, dt);
  const acceleration = ax.map((value, i) => Math.hypot(value, ay[i]));
  const jerkX = derivative(ax, dt), jerkY = derivative(ay, dt);
  const jerk = jerkX.map((value, i) => Math.hypot(value, jerkY[i]));
  const curvature = vx.map((value, i) => {
    const denominator = Math.pow(Math.max(speed[i], EPSILON), 3);
    return (value * ay[i] - vy[i] * ax[i]) / denominator;
  });
  const rawPressure = samples.map(point => point.pressure);
  const pressureValues = rawPressure.filter(Number.isFinite);
  const pointerTypes = new Set(samples.map(point => point.pointerType));
  const hasNativePressure = !pointerTypes.has('mouse') && pressureValues.length >= Math.max(4, Math.floor(samples.length * 0.25))
    && new Set(pressureValues.map(value => value.toFixed(4))).size >= 4;
  const minSpeed = Math.min(...speed), maxSpeed = Math.max(...speed);
  const speedRange = maxSpeed - minSpeed + EPSILON;
  const centerX = median(x), centerY = median(y);
  const radii = x.map((value, i) => Math.hypot(value - centerX, y[i] - centerY));
  let spatialScale = percentile(radii, 0.95);
  if (!Number.isFinite(spatialScale) || spatialScale <= EPSILON) spatialScale = 1;
  const proxy = speed.map((value, i) => {
    const speedNorm = (value - minSpeed) / speedRange;
    const radiusNorm = radii[i] / spatialScale;
    return 0.65 * (1 - 0.35 * speedNorm) + 0.15 * Math.min(1.5, Math.max(0, radiusNorm));
  });
  const fillPressure = median(pressureValues);
  const pressure = rawPressure.map((value, i) => hasNativePressure && Number.isFinite(value) ? value
    : hasNativePressure ? fillPressure : proxy[i]);
  const pressureDerivative = derivative(pressure, dt);
  const azimuth = samples.map(point => Math.atan2(point.tiltY || 0, point.tiltX || 0));
  for (let i = 1; i < azimuth.length; i++) {
    while (azimuth[i] - azimuth[i - 1] > Math.PI) azimuth[i] -= 2 * Math.PI;
    while (azimuth[i] - azimuth[i - 1] < -Math.PI) azimuth[i] += 2 * Math.PI;
  }
  const azimuthDerivative = derivative(azimuth, dt);
  const movementHeading = vx.map((value, i) => Math.atan2(vy[i], value));
  for (let i = 1; i < movementHeading.length; i++) {
    while (movementHeading[i] - movementHeading[i - 1] > Math.PI) movementHeading[i] -= 2 * Math.PI;
    while (movementHeading[i] - movementHeading[i - 1] < -Math.PI) movementHeading[i] += 2 * Math.PI;
  }
  const angularVelocity = derivative(movementHeading, dt);
  const wavelets = waveletDetailsDb4(speed, 5);
  const channels = [x, y, pressure, vx, vy, speed, ax, ay, acceleration, jerk, curvature,
    pressureDerivative, azimuthDerivative, ...wavelets, proxy];
  return { channels, speed, acceleration, jerk, angularVelocity, durationSeconds: samples.length / sampleRateHz };
}

function normalizeWindow(channels, start, length) {
  return channels.map(channel => {
    const values = channel.slice(start, start + length);
    let mean = 0;
    for (const value of values) mean += value;
    mean /= values.length;
    let variance = 0;
    for (const value of values) variance += (value - mean) ** 2;
    const std = Math.sqrt(variance / values.length);
    const denom = Math.max(std, EPSILON);
    return values.map(value => (value - mean) / denom);
  });
}

/**
 * Extract per-window V6 tensors from existing 14-column pointer tuples.
 * @param {Array<Array<number|string|null>|object>} trajectory Raw task trajectory.
 * @param {{sampleRateHz?:number,deviceType?:string,deviceCutoffs?:object}} options Pipeline options.
 * @returns {{windows:Array<Array<Array<number>>>,sampleCount:number,durationSeconds:number,diagnostics:object}}
 */
export function extractV6FeatureWindows(trajectory, options = {}) {
  const sampleRateHz = Number(options.sampleRateHz || V6_CANONICAL_RATE_HZ);
  if (!Array.isArray(trajectory) || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new TypeError('A trajectory and positive sample rate are required.');
  }
  const cutoffs = options.deviceCutoffs || {};
  const deviceType = options.deviceType || 'unknown';
  const cutoffHz = Number(cutoffs[deviceType] || cutoffs.unknown || 12);
  const grouped = new Map();
  let validRawPointCount = 0;
  let invalidRawPointCount = 0;
  trajectory.forEach((raw, index) => {
    const point = readPoint(raw, index);
    if (point.x === null || point.y === null || point.timeMs === null) {
      invalidRawPointCount++;
      return;
    }
    validRawPointCount++;
    const key = point.strokeIndex;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(point);
  });
  const resampledBlocks = [...grouped.values()].map(points => resampleStroke(points, sampleRateHz));
  const blocks = resampledBlocks.filter(points => points.length >= 2);
  const derived = blocks.map(block => deriveBlock(block, cutoffHz, sampleRateHz));
  const channels = V6_FEATURE_NAMES.map((_, index) => derived.flatMap(block => block.channels[index]));
  const sampleCount = channels[0]?.length || 0;
  const windows = [];
  for (let start = 0; start < sampleCount; start += V6_WINDOW_STRIDE) {
    const length = Math.min(V6_WINDOW_SIZE, sampleCount - start);
    if (length < V6_MIN_SEQUENCE_LENGTH) break;
    windows.push(normalizeWindow(channels, start, length));
  }
  const totalRawPoints = trajectory.length;
  const insufficientReasonCode = windows.length ? null
    : sampleCount > 0 ? 'too_few_resampled_samples'
      : validRawPointCount > 0 ? 'no_resampled_samples' : 'no_usable_points';
  const nativePressurePoints = trajectory.reduce((count, point) => {
    const parsed = readPoint(point, count);
    return count + (parsed.pressure !== null && parsed.pointerType !== 'mouse' ? 1 : 0);
  }, 0);
  const angularVelocityRms = derived.map(block => Math.sqrt(block.angularVelocity.reduce((sum, value) => sum + value * value, 0) / Math.max(1, block.angularVelocity.length)));
  const ldj = derived.map(block => {
    const duration = Math.max(block.durationSeconds, EPSILON);
    const pathLength = Math.max(block.speed.reduce((sum, value) => sum + value / sampleRateHz, 0), EPSILON);
    const squaredJerkIntegral = block.jerk.reduce((sum, value) => sum + value * value / sampleRateHz, 0);
    return Math.log((duration ** 5 * squaredJerkIntegral) / (pathLength ** 2) + EPSILON);
  });
  return {
    windows,
    sampleCount,
    durationSeconds: derived.reduce((sum, block) => sum + block.durationSeconds, 0),
    diagnostics: {
      featureContract: V6_FEATURE_CONTRACT,
      featureNames: [...V6_FEATURE_NAMES],
      sampleRateHz,
      deviceType,
      cutoffHz,
      rawPointCount: totalRawPoints,
      validRawPointCount,
      invalidRawPointCount,
      inputStrokeCount: grouped.size,
      resampledStrokeCount: blocks.length,
      rejectedStrokeCount: grouped.size - blocks.length,
      resampledSampleCount: sampleCount,
      minimumRequiredSamples: V6_MIN_SEQUENCE_LENGTH,
      insufficientReasonCode,
      nativePressurePointCount: nativePressurePoints,
      angularVelocityRmsByStroke: angularVelocityRms,
      ldjByStroke: ldj,
      ldj: ldj.length ? ldj.reduce((sum, value) => sum + value, 0) / ldj.length : null,
      tremorWaveletLevelsHzApprox: { level3: [6.25, 12.5], level4: [3.125, 6.25] }
    }
  };
}

/** Map observed/self-reported input to the exact device embedding IDs in the scaler. */
export function mapDeviceDomain(pointerTypes, selfReportedDevice, lookup = {}) {
  const normalizedSelf = String(selfReportedDevice || '').toLowerCase();
  const observed = new Set(pointerTypes || []);
  let domain = 'unknown';
  if (normalizedSelf === 'wacom_tablet') domain = 'wacom';
  else if (normalizedSelf === 'stylus_tablet') domain = 'stylus';
  else if (normalizedSelf === 'phone' || normalizedSelf === 'tablet') domain = 'touch';
  else if (normalizedSelf === 'mouse' || normalizedSelf === 'laptop_touchpad') domain = 'mouse';
  else if (observed.size === 1 && observed.has('pen')) domain = 'stylus';
  else if (observed.size === 1 && observed.has('touch')) domain = 'touch';
  else if (observed.size === 1 && observed.has('mouse')) domain = 'mouse';
  const ids = lookup || {};
  return { domain, deviceId: Number.isInteger(ids[domain]) ? ids[domain] : Number(ids.unknown ?? 4) };
}

/** Calculate angular motion details kept as diagnostics (not extra model channels). */
export function calculateAngularVelocityAndLdJ(trajectory, options = {}) {
  return extractV6FeatureWindows(trajectory, options).diagnostics;
}
