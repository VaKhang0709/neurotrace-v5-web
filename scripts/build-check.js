import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateV6Scaler, V6_MODEL_TIERS } from '../src/utils/onnx_inference.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  ...Object.values(V6_MODEL_TIERS).map(({ file }) => `public/models/v6/${file}`),
  'public/models/v6/scaler_config_v6.json',
  'src/utils/v6_feature_extractor.js',
  'src/utils/onnx_inference.js',
  'src/utils/outbox_sync.js',
  'src/v6_collector.js',
  'collect.html', 'firestore.rules', 'i18n/en.json', 'i18n/vi.json'
];
const preservedV5 = {
  'neurotrace_v5.onnx': 'a672a165cfb24bcd62c54a72a3bd13c1595632d0e2a69116914200d2d09b8d22',
  'scaler_config_v5.json': '1794268b11caec9ad638ebcfc5273f17f71fcb6e8e1d4ef8b76fad284c5072dc',
  'preprocess_v5.js': '1aa4e53288dc1825d1d6ffe55a54c55d8a88807287fe463d050d3f35eefe2e90',
  'index.html': 'f2ba5698cc01bb98ec8b4636e2002cc6625718b59d79d816f0118e5846298e4c'
};

for (const file of requiredFiles) await access(path.join(root, file));
const scaler = JSON.parse(await readFile(path.join(root, 'public/models/v6/scaler_config_v6.json'), 'utf8'));
validateV6Scaler(scaler);
const hashes = {};
for (const [tier, metadata] of Object.entries(V6_MODEL_TIERS)) {
  const hash = createHash('sha256');
  const file = path.join(root, 'public/models/v6', metadata.file);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  hashes[tier] = hash.digest('hex');
  if (hashes[tier] !== metadata.sha256) throw new Error(`V6 ${tier.toUpperCase()} SHA-256 does not match the family manifest.`);
}
if (scaler.parity?.onnx_sha256 !== hashes.pro) throw new Error('V6 scaler parity hash does not match the shipped PRO artifact.');
if (scaler.feature_contract !== 'v6-dwt19-v1' || scaler.feature_names.length !== 19) {
  throw new Error('V6 scaler does not declare the exact v6-dwt19-v1 19-channel contract.');
}
for (const [file, expected] of Object.entries(preservedV5)) {
  const bytes = await readFile(path.join(root, file));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Protected V5 artifact changed: ${file}`);
}
const sources = [
  'preprocess_v5.js', 'src/firebase_client.js', 'src/local_store.js',
  'src/v6_collector.js', 'src/utils/v6_feature_extractor.js', 'src/utils/onnx_inference.js', 'src/utils/outbox_sync.js'
];
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.stdout}`);
}
const html = await readFile(path.join(root, 'collect.html'), 'utf8');
const form = html.match(/<form id="feedbackForm"[\s\S]*?<\/form>/)?.[0] || '';
if (!/name="tremor_status" value="yes" required/.test(form)
  || !/name="tremor_status" value="no" required/.test(form)
  || !/name="tremor_status" value="prefer_not_to_say" required/.test(form)
  || !/name="pro_server_reevaluation_consent"/.test(form)) {
  throw new Error('Feedback form must require tremor status and keep optional PRO consent inside the submission form.');
}
const en = JSON.parse(await readFile(path.join(root, 'i18n/en.json'), 'utf8'));
const vi = JSON.parse(await readFile(path.join(root, 'i18n/vi.json'), 'utf8'));
for (const key of [
  'modelMode', 'modelAuto', 'modelBase', 'modelNano', 'tremorStatus', 'proServerConsent',
  'proServerConsentDesc', 'v6CalibrationPolicy', 'submissionQueuedLocal', 'submissionLocalOnly',
  'submissionWaiting', 'submissionConfirmed', 'submissionQueueCleanupPending', 'v6InsufficientSamples',
  'v6InsufficientNoPoints', 'v6InsufficientNoResample'
]) {
  if (!en[key] || !vi[key]) throw new Error(`Missing V6 family translation: ${key}`);
}
const rules = await readFile(path.join(root, 'firestore.rules'), 'utf8');
const collector = await readFile(path.join(root, 'src/v6_collector.js'), 'utf8');
if (!rules.includes("status == 'request_recorded_only'") || rules.includes("status == 'pending'")) {
  throw new Error('PRO consent metadata must not imply a pending server job.');
}
if (!collector.includes("status: 'request_recorded_only'") || !en.proServerConsentDesc.includes('no PRO server worker is currently running')) {
  throw new Error('Client submission must describe PRO as request metadata only; no server worker is running.');
}
console.log(`Static family contract passed: BASE ${hashes.base}, NANO ${hashes.nano}, PRO ${hashes.pro}; protected V5 files unchanged.`);
