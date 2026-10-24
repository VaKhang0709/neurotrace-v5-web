// NeuroTrace V5 browser preprocessor.
// Ported from train_pipeline_v5_diagnostic.py::extract_trial_windows and
// transform_with_scaler. Input samples use canvas-space x/y, event timestamps
// in milliseconds, and nativePressure when available.

export const V5_SEQ_LEN = 256;
export const V5_SAMPLE_RATE_HZ = 100;
export const V5_WINDOW_SIZE = 256;
export const V5_WINDOW_STRIDE = 64;
export const V5_CHANNELS = Object.freeze(['x', 'y', 'pressure', 'velocity', 'dt']);

// 4th-order Butterworth low-pass SOS for 12 Hz at 100 Hz. The first section
// carries the combined DC gain; the cascade is transfer-function equivalent
// to scipy.signal.butter(4, 12, fs=100, output='sos').
const BUTTERWORTH_12HZ_SOS = [
  [0.008914457239463023, 0.017828914478926046, 0.008914457239463023, 1, -1.1552915050582222, 0.5848302129885163],
  [1, 2, 1, 1, -0.8931036327062872, 0.22516058868743405]
];
const FILTER_PAD_LENGTH = 15;
const EPSILON = 1e-6;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function interpolate(sourceTimes, sourceValues, targetTimes) {
  const output = new Array(targetTimes.length);
  let right = 1;
  for (let i = 0; i < targetTimes.length; i++) {
    const target = targetTimes[i];
    if (target <= sourceTimes[0]) { output[i] = sourceValues[0]; continue; }
    if (target >= sourceTimes[sourceTimes.length - 1]) { output[i] = sourceValues[sourceValues.length - 1]; continue; }
    while (right < sourceTimes.length - 1 && sourceTimes[right] < target) right++;
    const left = right - 1;
    const span = sourceTimes[right] - sourceTimes[left];
    const alpha = span > 0 ? (target - sourceTimes[left]) / span : 0;
    output[i] = sourceValues[left] + (sourceValues[right] - sourceValues[left]) * alpha;
  }
  return output;
}

function sectionSteadyState(sos, inputValue) {
  const [b0, b1, b2, , a1, a2] = sos;
  const dcGain = (b0 + b1 + b2) / (1 + a1 + a2);
  const outputValue = dcGain * inputValue;
  return { dcGain, zi1: outputValue - b0 * inputValue, zi2: b2 * inputValue - a2 * outputValue };
}

function filterCascade(values) {
  let output = values;
  let steadyInput = values[0];
  for (const sos of BUTTERWORTH_12HZ_SOS) {
    const [b0, b1, b2, , a1, a2] = sos;
    const state = sectionSteadyState(sos, steadyInput);
    let z1 = state.zi1, z2 = state.zi2;
    const sectionOutput = new Array(output.length);
    for (let i = 0; i < output.length; i++) {
      const input = output[i];
      const filtered = b0 * input + z1;
      z1 = b1 * input - a1 * filtered + z2;
      z2 = b2 * input - a2 * filtered;
      sectionOutput[i] = filtered;
    }
    output = sectionOutput;
    steadyInput *= state.dcGain;
  }
  return output;
}

function lowPass12HzZeroPhase(values) {
  if (values.length <= FILTER_PAD_LENGTH) return [...values];
  const left = [];
  const right = [];
  for (let i = FILTER_PAD_LENGTH; i >= 1; i--) left.push(2 * values[0] - values[i]);
  for (let i = 2; i <= FILTER_PAD_LENGTH + 1; i++) right.push(2 * values[values.length - 1] - values[values.length - i]);
  const padded = [...left, ...values, ...right];
  const forward = filterCascade(padded);
  const reversed = filterCascade(forward.reverse());
  const backward = reversed.reverse();
  return backward.slice(FILTER_PAD_LENGTH, FILTER_PAD_LENGTH + values.length);
}

function gradientAt100Hz(values) {
  if (values.length < 2) return values.map(() => 0);
  const derivative = new Array(values.length);
  derivative[0] = (values[1] - values[0]) / 0.01;
  for (let i = 1; i < values.length - 1; i++) derivative[i] = (values[i + 1] - values[i - 1]) / 0.02;
  derivative[values.length - 1] = (values[values.length - 1] - values[values.length - 2]) / 0.01;
  return derivative;
}

function sliceWindows(matrix, windowSize, stride) {
  const count = matrix[0].length;
  if (count < 24) return [];
  if (count <= windowSize) return [matrix];
  const starts = [];
  for (let start = 0; start <= count - windowSize; start += stride) starts.push(start);
  if (starts[starts.length - 1] !== count - windowSize) starts.push(count - windowSize);
  return starts.map(start => matrix.map(channel => channel.slice(start, start + windowSize)));
}

function resampleWindow(window, targetLength) {
  const sourceLength = window[0].length;
  if (sourceLength === targetLength) return window.map(channel => [...channel]);
  return window.map(channel => {
    const output = new Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      const position = i * (sourceLength - 1) / (targetLength - 1);
      const left = Math.floor(position), right = Math.min(left + 1, sourceLength - 1);
      const alpha = position - left;
      output[i] = channel[left] + (channel[right] - channel[left]) * alpha;
    }
    return output;
  });
}

function normalizeWindow(window) {
  const length = window[0].length;
  const x = window[0], y = window[1], pressure = window[2], velocity = window[3], dt = window[4];
  const meanX = x.reduce((sum, value) => sum + value, 0) / length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / length;
  const centeredX = x.map(value => value - meanX);
  const centeredY = y.map(value => value - meanY);
  const spatialScale = Math.sqrt(centeredX.reduce((sum, value, i) => sum + value * value + centeredY[i] * centeredY[i], 0) / length);
  if (!Number.isFinite(spatialScale) || spatialScale <= 1e-8) return null;

  const meanPressure = pressure.reduce((sum, value) => sum + value, 0) / length;
  const pressureStd = Math.sqrt(pressure.reduce((sum, value) => sum + (value - meanPressure) ** 2, 0) / length);
  const medianDt = median(dt);
  return [
    centeredX.map(value => value / spatialScale),
    centeredY.map(value => value / spatialScale),
    pressure.map(value => (value - meanPressure) / (pressureStd + 1e-5)),
    [...velocity],
    dt.map(value => (value - medianDt) / (medianDt + EPSILON))
  ];
}

/**
 * Port the verified V5 trial path: repair timestamps, resample the whole trial
 * to 100 Hz, spatially normalize over the complete trial, apply a zero-phase
 * 12 Hz Butterworth low-pass, derive velocity from filtered coordinates, form
 * 256-step/64-stride windows, then apply per-window XY/pressure/dt transforms.
 * Returns unscaled channel-first windows: [window][5][256].
 */
export function preprocessV5Trial(rawSamples, { forcePressureProxy = false } = {}) {
  const samples = (rawSamples || []).filter(sample =>
    Number.isFinite(Number(sample.x)) && Number.isFinite(Number(sample.y)) && Number.isFinite(Number(sample.t))
  );
  if (samples.length < 20) throw new Error('Draw a longer stroke (at least 20 samples) to preprocess.');

  const timeSeconds = samples.map(sample => Number(sample.t) / 1000.0);
  const dtRaw = timeSeconds.map((time, i) => i === 0 ? 0 : time - timeSeconds[i - 1]);
  dtRaw[0] = dtRaw.length > 1 ? dtRaw[1] : 0.01;
  const positiveDt = dtRaw.filter(value => value > 0 && Number.isFinite(value));
  if (positiveDt.length < 16) throw new Error('The stroke has too few valid time intervals.');
  const medianDt = median(positiveDt);
  const dtRepaired = dtRaw.map(value => value > 0 ? value : medianDt);
  const cleanTimes = [0];
  for (let i = 1; i < dtRepaired.length; i++) {
    const boundedDt = Math.min(10 * medianDt, Math.max(0.05 * medianDt, dtRepaired[i]));
    cleanTimes.push(cleanTimes[i - 1] + boundedDt);
  }
  const duration = cleanTimes[cleanTimes.length - 1];
  if (!Number.isFinite(duration) || duration < 0.4) throw new Error('Draw a continuous stroke lasting at least 0.4 seconds.');

  const gridCount = Math.max(48, Math.round(duration * V5_SAMPLE_RATE_HZ) + 1);
  const gridTimes = Array.from({ length: gridCount }, (_, i) => duration * i / (gridCount - 1));
  const rawX = samples.map(sample => Number(sample.x));
  const rawY = samples.map(sample => Number(sample.y));
  const xGrid = interpolate(cleanTimes, rawX, gridTimes);
  const yGrid = interpolate(cleanTimes, rawY, gridTimes);
  const dtGrid = interpolate(cleanTimes, dtRepaired, gridTimes);

  // Whole-trial radial normalization is shared by filtered XY and the pressure proxy.
  const centerX = median(xGrid), centerY = median(yGrid);
  const radii = xGrid.map((value, i) => Math.hypot(value - centerX, yGrid[i] - centerY));
  let spatialScale = percentile(radii, 0.95);
  if (!Number.isFinite(spatialScale) || spatialScale <= 1e-9) spatialScale = 1;
  const xSpatial = xGrid.map(value => (value - centerX) / spatialScale);
  const ySpatial = yGrid.map(value => (value - centerY) / spatialScale);
  const radiusNorm = radii.map(value => value / spatialScale);

  const xFiltered = lowPass12HzZeroPhase(xSpatial);
  const yFiltered = lowPass12HzZeroPhase(ySpatial);
  const dtFiltered = lowPass12HzZeroPhase(dtGrid);
  const velocityX = gradientAt100Hz(xFiltered);
  const velocityY = gradientAt100Hz(yFiltered);
  const speed = velocityX.map((value, i) => Math.hypot(value, velocityY[i]));

  const suppliedPressure = samples.map(sample => {
    const value = Number(sample.nativePressure);
    return Number.isFinite(value) ? value : NaN;
  });
  const hasVariedPressure = !forcePressureProxy && samples.some(sample => sample.pointerType !== 'mouse') &&
    new Set(suppliedPressure.filter(Number.isFinite).map(value => value.toFixed(4))).size >= 4;
  let pressureFiltered;
  if (hasVariedPressure) {
    const finitePressure = suppliedPressure.filter(Number.isFinite);
    const fillPressure = median(finitePressure);
    const pressureGrid = interpolate(cleanTimes, suppliedPressure.map(value => Number.isFinite(value) ? value : fillPressure), gridTimes);
    pressureFiltered = lowPass12HzZeroPhase(pressureGrid);
  } else {
    const minSpeed = speed.reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const maxSpeed = speed.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
    const speedRange = maxSpeed - minSpeed + EPSILON;
    pressureFiltered = speed.map((value, i) => {
      const speedNorm = (value - minSpeed) / speedRange;
      return 0.65 * (1.0 - 0.35 * speedNorm) + 0.15 * Math.min(1.5, Math.max(0, radiusNorm[i]));
    });
  }

  const windows = sliceWindows([xFiltered, yFiltered, pressureFiltered, speed, dtFiltered], V5_WINDOW_SIZE, V5_WINDOW_STRIDE);
  const normalized = windows.map(window => normalizeWindow(resampleWindow(window, V5_SEQ_LEN))).filter(Boolean);
  if (!normalized.length) throw new Error('No usable V5 signal windows were found. Draw a larger, more varied path.');
  return normalized;
}

/** Standardize one V5 window and pack it in ONNX [1, 5, 256] channel-first order. */
export function standardizeV5Window(window, scaler) {
  if (!Array.isArray(window) || window.length !== V5_CHANNELS.length || window.some(channel => channel.length !== V5_SEQ_LEN)) {
    throw new Error('Expected a V5 feature window with shape [5, 256].');
  }
  if (!scaler || !Array.isArray(scaler.mean) || !Array.isArray(scaler.scale) || scaler.mean.length !== 5 || scaler.scale.length !== 5) {
    throw new Error('V5 scaler must contain five means and scales.');
  }
  const data = new Float32Array(1 * V5_CHANNELS.length * V5_SEQ_LEN);
  for (let channel = 0; channel < V5_CHANNELS.length; channel++) {
    if (!Number.isFinite(scaler.mean[channel]) || !Number.isFinite(scaler.scale[channel]) || scaler.scale[channel] === 0) {
      throw new Error(`Invalid scaler statistics for ${V5_CHANNELS[channel]}.`);
    }
    const offset = channel * V5_SEQ_LEN;
    for (let time = 0; time < V5_SEQ_LEN; time++) {
      data[offset + time] = (window[channel][time] - scaler.mean[channel]) / scaler.scale[channel];
    }
  }
  return data;
}
