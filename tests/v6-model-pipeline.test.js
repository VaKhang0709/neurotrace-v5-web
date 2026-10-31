import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  V6_FEATURE_NAMES,
  extractV6FeatureWindows,
  mapDeviceDomain,
  butterworthLowPass
} from '../src/utils/v6_feature_extractor.js';
import {
  normalizeV6Window,
  runV6Assessment,
  validateV6Scaler
} from '../src/utils/onnx_inference.js';

const scaler = JSON.parse(await readFile(new URL('../public/models/v6/scaler_config_v6.json', import.meta.url), 'utf8'));

function trajectory({ points = 700, pointerType = 'mouse', pressure = null, strokeIndex = 0 } = {}) {
  return Array.from({ length: points }, (_, i) => [
    160 + 75 * Math.sin(i / 18),
    180 + 42 * Math.sin(i / 9),
    i * 10000,
    typeof pressure === 'function' ? pressure(i) : pressure,
    pointerType === 'pen' ? 8 + 2 * Math.sin(i / 20) : 0,
    pointerType === 'pen' ? 4 + 2 * Math.cos(i / 25) : 0,
    pointerType === 'pen' ? 0 : null,
    pointerType, 1, 1, 2, 2, true, strokeIndex
  ]);
}

test('V6 scaler declares the exact fixed 19-channel order and normalization contract', () => {
  assert.equal(validateV6Scaler(scaler), scaler);
  assert.equal(V6_FEATURE_NAMES.length, 19);
  assert.deepEqual(scaler.feature_names, V6_FEATURE_NAMES);
  assert.equal(scaler.feature_contract, 'v6-dwt19-v1');
  assert.equal(scaler.reference_sequence_length, 512);
  assert.equal(scaler.apply_global_standardization, false);
});

test('feature windows use dynamic 19-channel tensors and finite per-window normalization', () => {
  const result = extractV6FeatureWindows(trajectory(), {
    sampleRateHz: scaler.canonical_rate_hz,
    deviceType: 'mouse',
    deviceCutoffs: scaler.device_filter_cutoff_hz
  });
  assert.ok(result.windows.length >= 2);
  for (const window of result.windows) {
    assert.equal(window.length, 19);
    assert.ok(window[0].length >= scaler.minimum_engineering_sequence_length);
    for (const channel of window) {
      assert.ok(channel.every(Number.isFinite));
      const mean = channel.reduce((sum, value) => sum + value, 0) / channel.length;
      assert.ok(Math.abs(mean) < 1e-6);
    }
  }
  assert.equal(result.diagnostics.featureContract, scaler.feature_contract);
  assert.equal(result.diagnostics.nativePressurePointCount, 0);
  assert.ok(Number.isFinite(result.diagnostics.ldj));
});

test('native stylus pressure and device embedding mappings are retained without forcing a class label', () => {
  const points = trajectory({ pointerType: 'pen', pressure: i => 0.1 + 0.8 * (0.5 + 0.5 * Math.sin(i / 7)) });
  const result = extractV6FeatureWindows(points, {
    sampleRateHz: scaler.canonical_rate_hz,
    deviceType: 'stylus',
    deviceCutoffs: scaler.device_filter_cutoff_hz
  });
  assert.ok(result.diagnostics.nativePressurePointCount > 0);
  assert.deepEqual(mapDeviceDomain(['pen'], null, scaler.device_embedding_lookup), { domain: 'stylus', deviceId: 3 });
  assert.equal(mapDeviceDomain(['pen', 'mouse'], null, scaler.device_embedding_lookup).domain, 'unknown');
  assert.equal(mapDeviceDomain(['mouse'], 'wacom_tablet', scaler.device_embedding_lookup).deviceId, 0);
});

test('Butterworth and DB4 feature outputs stay finite for short/edge windows', () => {
  const filtered = butterworthLowPass([0, 1, 0, -1, 0], 12, 100);
  assert.equal(filtered.length, 5);
  assert.ok(filtered.every(Number.isFinite));
  const normalized = normalizeV6Window(Array.from({ length: 19 }, (_, channel) => Array.from({ length: 64 }, (_, i) => channel ? Math.sin(i / (channel + 1)) : 2)));
  assert.equal(normalized.length, 19);
  assert.ok(normalized.flat().every(Number.isFinite));
});

test('runner supplies dynamic trajectory plus int64 device id, raw score, task breakdown, and honest confidence availability', async () => {
  class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  }
  const runtime = {
    Tensor,
    env: { wasm: {} },
    InferenceSession: {
      create: async url => {
        assert.equal(url, '/models/v6/neurotrace_v6_tremorformer.onnx');
        return {
          inputNames: ['trajectory', 'device_id'],
          outputNames: ['logits'],
          run: async feeds => {
            assert.deepEqual(feeds.trajectory.dims.slice(0, 2), [1, 19]);
            assert.ok(feeds.trajectory.dims[2] >= 64 && feeds.trajectory.dims[2] <= 512);
            assert.equal(feeds.device_id.type, 'int64');
            assert.deepEqual(feeds.device_id.dims, [1]);
            assert.equal(feeds.device_id.data[0], 2n);
            return { logits: { data: Float32Array.of(0.25) } };
          }
        };
      }
    }
  };
  const fetcher = async url => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(await readFile(new URL(`../public${url}`, import.meta.url), 'utf8'))
  });
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    task_id: `task_${index + 1}`,
    trajectory: index === 5 ? [] : trajectory({ points: 100 }),
    pointer_types: new Set(['mouse']),
    skipped: index === 5
  }));
  const result = await runV6Assessment(tasks, { runtime, fetcher });
  assert.equal(result.feature_contract, 'v6-dwt19-v1');
  assert.equal(result.device_id, 2);
  assert.equal(result.scored_task_count, 5);
  assert.equal(result.task_results.length, 6);
  assert.ok(Math.abs(result.raw_probability - (1 / (1 + Math.exp(-0.25)))) < 1e-6);
  assert.equal(result.task_results[5].status, 'unavailable');
  assert.equal(result.domain_confidence, null);
  assert.match(result.domain_confidence_reason, /no domain-confidence output/i);
});
