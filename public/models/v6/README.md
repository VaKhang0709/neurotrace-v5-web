# TremorFormer V6 ONNX export

## Production source synchronization

Synchronized from Google Drive folder `NEUROTRACE/v6_production/` on 2026-11-01, per the Tech Lead's 50-epoch production designation. The Drive model's modified time is `2026-10-31T15:04:57Z`; the scaler's is `2026-10-31T15:05:16Z`. Their downloaded bytes are identical to the artifacts already in this branch (no model/scaler content delta). The scaler itself does not contain an epoch-count field, so the 50-epoch designation is source-owner provenance, not independently machine-verified here.

- Model: `neurotrace_v6_tremorformer.onnx`
- Scaler/feature contract: `scaler_config_v6.json`
- Contract: `v6-dwt19-v1`
- ONNX inputs: `trajectory` (`float32 [batch, 19, dynamic_time]`) and `device_id` (`int64 [batch]`)
- ONNX output: `logits` (raw logit; apply sigmoid)
- Reference sequence length: 512; minimum engineering length: 64; canonical sample rate: 100 Hz
- SHA-256: `0593c9c17470f7868f70aa2bc5de6fa51e2dfb27d067bfd15c83648cf28424b4`
- The scaler marks `clinical_validation` as `NOT_ESTABLISHED`; its small validation-set calibration may overfit.

The ONNX graph emits no domain-confidence output. Do not infer or present a domain-confidence score from the device embedding. The scaler's mean/std values are training diagnostics; V6 applies only its declared per-window population z-score normalization.
