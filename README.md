# NeuroTrace V5 Web Prototype

A static, browser-based handwriting-signal prototype. It captures pointer movement, derives pressure/velocity/time-delta features, resamples them to 256 steps, applies the supplied scaler statistics, and runs ONNX inference with ONNX Runtime Web (WASM).

## Deploy and run

Serve this directory from an HTTP(S) static server (do not open `index.html` as a `file://` URL). Put the two production artifacts beside `index.html`:

- `neurotrace_v5.onnx`
- `scaler_config_v5.json`

For example, after copying the model artifacts from the project’s model storage, run `python -m http.server 8000` in this directory and open `http://localhost:8000`. The ONNX Runtime Web script is loaded from jsDelivr, so an internet connection is needed unless the runtime is hosted locally.

The scaler JSON must provide `mean` and `scale` values in the channel order `x`, `y`, `pressure`, `velocity`, `dt` (either arrays in that order or values grouped by channel). The model is expected to accept a float32 input tensor shaped `[1, 5, 256]`; a one-value output is interpreted as a sigmoid probability or logit, and a multi-value output as class scores.

## Privacy and intended use

Stroke processing and inference run in the browser. This is a research/demo prototype, not a medical device or a diagnostic tool. Its output must not be used to make health decisions; consult a qualified healthcare professional for medical concerns.

## Repository artifact note

The production ONNX model and scaler were not present in this repository checkout, so they are intentionally not fabricated or replaced with placeholder data. Add the actual artifacts at deployment time.
