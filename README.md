# NeuroTrace V5 Web Prototype

A static, browser-based handwriting-signal research prototype. `index.html` imports the shared browser preprocessor in `preprocess_v5.js`, applies the production scaler, and runs ONNX Runtime Web (WASM).

## V5 preprocessing and inference

The browser preprocessor ports the V5 training path: timestamp repair and uniform 100 Hz resampling; whole-trial spatial normalization; a zero-phase, 4th-order 12 Hz Butterworth low-pass; post-filter velocity and the V5 virtual-pressure proxy where native pressure is unavailable; 256-sample windows at stride 64; per-window spatial, pressure, and `dt` normalization; then scaler standardization and channel-first `[1, 5, 256]` tensor packing. When a trial produces multiple windows, the UI averages their model probabilities.

The synthetic PD-style and healthy-style presets are generated motion patterns for UI/preprocessor flow checks only. They are not UCI participant records, clinical test vectors, or evidence of model validation.

## Deploy and run

Serve this directory over HTTP(S) (do not open `index.html` as a `file://` URL). These files must be in the same directory:

- `index.html`
- `preprocess_v5.js`
- `neurotrace_v5.onnx`
- `scaler_config_v5.json`

For example, run `python -m http.server 8000` in this directory and open `http://localhost:8000`. The ONNX Runtime Web script loads from jsDelivr, so an internet connection is needed unless the runtime is hosted locally.

The scaler JSON provides `mean` and `scale` in channel order `x`, `y`, `pressure`, `velocity`, `dt`; the model accepts float32 `[1, 5, 256]` windows and emits a raw logit that is passed through sigmoid.

## Dataset scope, privacy, and intended use

Training/report metadata identifies Wacom digitizer UCI #395 trials and mobile-app touchscreen healthy-control samples (with virtual sessions in the production run). The app's touchscreen and mouse use remain experimental domain-adaptation inputs; mouse data is not independently clinically validated. Stroke processing and inference run in the browser. This is not a medical device or diagnostic tool, and its output must not guide health decisions. Consult a qualified healthcare professional for medical concerns.
