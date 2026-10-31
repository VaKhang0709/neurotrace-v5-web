import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateV6Scaler } from '../src/utils/onnx_inference.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'public/models/v6/neurotrace_v6_tremorformer.onnx',
  'public/models/v6/scaler_config_v6.json',
  'models/v6/neurotrace_v6_tremorformer.onnx',
  'src/utils/v6_feature_extractor.js',
  'src/utils/onnx_inference.js',
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
const hash = createHash('sha256');
for await (const chunk of createReadStream(path.join(root, 'public/models/v6/neurotrace_v6_tremorformer.onnx'))) hash.update(chunk);
const modelHash = hash.digest('hex');
if (modelHash !== scaler.parity?.onnx_sha256) throw new Error('V6 ONNX SHA-256 does not match the exported scaler parity manifest.');
for (const [file, expected] of Object.entries(preservedV5)) {
  const bytes = await readFile(path.join(root, file));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Protected V5 artifact changed: ${file}`);
}
const sources = [
  'preprocess_v5.js', 'src/firebase_client.js', 'src/local_store.js',
  'src/v6_collector.js', 'src/utils/v6_feature_extractor.js', 'src/utils/onnx_inference.js'
];
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.stdout}`);
}
JSON.parse(await readFile(path.join(root, 'i18n/en.json'), 'utf8'));
JSON.parse(await readFile(path.join(root, 'i18n/vi.json'), 'utf8'));
console.log(`Static build contract passed; V6 ONNX SHA-256 ${modelHash}; V5 protected files unchanged.`);
