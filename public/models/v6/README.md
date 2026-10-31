# TremorFormer V6 ONNX export

- Model: `neurotrace_v6_tremorformer.onnx`
- Scaler/feature contract: `scaler_config_v6.json`
- Contract: `v6-dwt19-v1`
- ONNX inputs: `trajectory` (`float32 [batch, 19, dynamic_time]`) and `device_id` (`int64 [batch]`)
- ONNX output: `logits` (raw logit; apply sigmoid)
- Reference sequence length: 512; minimum engineering length: 64; canonical sample rate: 100 Hz
- SHA-256: `0593c9c17470f7868f70aa2bc5de6fa51e2dfb27d067bfd15c83648cf28424b4`
- The scaler marks `clinical_validation` as `NOT_ESTABLISHED`; its small validation-set calibration may overfit.

The ONNX graph emits no domain-confidence output. Do not infer or present a domain-confidence score from the device embedding. The scaler's mean/std values are training diagnostics; V6 applies only its declared per-window population z-score normalization.
