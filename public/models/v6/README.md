# NeuroTrace V6 three-tier ONNX family

This directory contains the accepted `v6-family-1` release bundle from `NEUROTRACE/v6_production/family/`:

| Tier | Artifact | Precision | Size (bytes) | SHA-256 |
|---|---|---:|---:|---|
| NANO | `neurotrace_v6_nano.onnx` | INT8 | 1,370,917 | `38ab0ae21b78085e3bf9c80618719e33f2fb790678a8f97d0ab9f3e198cb8f09` |
| BASE | `neurotrace_v6_base.onnx` | FP16 | 7,426,918 | `9e89ce556808f5aa9aa3d36ad19989099cecb0f7db44ddf3d2a518e9ac2d6ce8` |
| PRO | `neurotrace_v6_pro.onnx` | FP32 | 63,112,269 | `1b69d67c13baa772fc020401d687c133634125d868ce01d136bf1db852419e9e` |
| Shared scaler | `scaler_config_v6.json` | — | 3,754 | `ffaae2b84ef8678ff124a98698fe75af7aadf95469da94a20946513fe74b5491` |

All tiers use the exact `v6-dwt19-v1` 19-channel order. ONNX inputs are `trajectory` (`float32 [batch, 19, dynamic_time]`) and `device_id` (`int64 [batch]`); output is the raw `logits` value. The frontend applies per-window population z-score normalization, averages sigmoid outputs as documented in the source, and preserves the fixed threshold 0.50. Shared teacher/isotonic calibration is **not** applied to the student family tiers. The scaler order, model signatures, hashes, and tensor shapes are checked, but full frontend preprocessing parity (including DWT edge behavior and angle derivation) remains unproven without canonical reference feature fixtures.

Online automatic client inference selects BASE. Offline, slow-connection/high-latency hints, or an explicit NANO setting selects NANO. Verified model bytes and loaded sessions are cached where browser storage permits. PRO is never loaded by client code; an optional, separate participant opt-in can add a `pending` PRO re-evaluation request to the consented Firestore session. This repository does not implement the server worker or claim that re-evaluation occurred.

## Research limitations

These artifacts are research-only; `clinical_validation` is `NOT_ESTABLISHED`. The supplied 15-subject locked Wacom holdout is a release-acceptance set, not untouched final validation. It reported specificity of 0.00 at threshold 0.50 for all tiers. Touchscreen PD sensitivity is not established; CPU timings are not mobile benchmarks. Do not use the outputs for diagnosis or health decisions. No deployment readiness or clinical validity is implied.
