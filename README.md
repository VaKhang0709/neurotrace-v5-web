# NeuroTrace Web Research Prototype

This repository contains the existing V5 on-device inference demo and a separate V6 consent-based research collection interface. The V5 pipeline remains available at `index.html`; the six-task V6 study flow is at `collect.html`.

## V5 preprocessing and inference

The browser preprocessor ports the V5 training path: timestamp repair and uniform 100 Hz resampling; whole-trial spatial normalization; a zero-phase, 4th-order 12 Hz Butterworth low-pass; post-filter velocity and the V5 virtual-pressure proxy where native pressure is unavailable; 256-sample windows at stride 64; per-window spatial, pressure, and `dt` normalization; then scaler standardization and channel-first `[1, 5, 256]` tensor packing. When a trial produces multiple windows, the UI averages their model probabilities.

The V5 synthetic PD-style and healthy-style presets are generated motion patterns for UI/preprocessor flow checks only. They are not UCI participant records, clinical test vectors, or evidence of model validation.

## V6 Data Collection Setup

### Default state and important limitations

The V6 collector is **offline by default**. `config/firebase_config.js` contains empty placeholders only. No Firebase keys or sample records are included, and no data is uploaded until a deployment deliberately supplies a valid project configuration and monitored research privacy contact. A collection submission is first saved in this browser's IndexedDB outbox; browser storage is best effort and cannot guarantee zero data loss or encryption at rest. The device UUID and fingerprint hash are pseudonymous and potentially linkable, not anonymous.

The collector is an adult-only, consent-based research interface and not a medical device. It asks for health-related information. The privacy and terms pages are deployment templates, not legal advice or a representation of GDPR compliance. Before enabling a real study, the research controller must complete legal identity/contact details, review consent and the processing basis for health data, define deletion/retention operations, and obtain institutional/security/privacy approval.

### Configure a Firebase project

1. Create a dedicated Firebase project for the research environment and register a Web app. Choose and document appropriate Firestore and Storage regions; review data residency and provider terms.
2. Enable **Anonymous Authentication**, create Firestore, create Firebase Storage, and enable Analytics only after reviewing the privacy/consent text. The client uses Firebase JS SDK 10.14.1 modular ES-module imports.
3. Supply the project web-app settings (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`) and the monitored `researchContactEmail`, `researchControllerName`, and `researchControllerAddress` through a deployment-owned configuration replacement/injection step. Do not commit real project values to this repository. Firebase web configuration is client-visible; Firestore/Storage rules and abuse controls—not secrecy of the browser config—must protect data.
4. Complete `privacy.html` and `terms.html` with the responsible controller's legal identity, contact, jurisdiction, Firebase processors/regions, and reviewed deletion/retention process. The client keeps cloud collection offline until the contact is valid.
5. Deploy and test the included deny-by-default rules in staging before collecting real records:
   ```sh
   firebase deploy --only firestore:rules,storage
   ```
   Verify consent-first writes, owner-only record access/deletion, private Storage paths, public aggregate-only reads, abuse controls, quotas, and backup/deletion workflows. Consider Firebase App Check and rate monitoring. Do not enable writes on permissive development rules.
6. The public dashboard reads only `v6_public_stats/current`. A trusted Cloud Function or administrative job must produce that aggregate; the browser is not permitted to write it. Apply disclosure controls (at minimum suppress cells under five and review combinations for re-identification risk). No dashboard data is bundled or seeded by this repo.
7. Serve the files over HTTPS (localhost is suitable for development). With empty Firebase configuration, the V5 inference demo remains usable and the V6 collector shows **Data collection offline**. Local consented drafts may be queued only for internal QA; do not recruit participants until project configuration, operator contact, security rules, and institutional approvals are complete.

### V6 data flow and interfaces

- `collect.html`: four-check consent modal, six independent canvas tasks, validated adult participant feedback form, resumable local drafts, local outbox, exponential retry, English/Vietnamese UI, high-contrast mode, skip/redo controls.
- `src/v6_collector.js`: raw pointer capture, session metadata, identity/fingerprint, V5 per-task inference, form checks and sync coordinator.
- `src/local_store.js`: IndexedDB outbox/draft access. Clearing local pending data cannot delete previously synchronized records.
- `src/firebase_client.js`: lazy Firebase modular SDK access, anonymous Auth, Firestore, Storage, Analytics after consent, aggregate-only dashboard reads.
- `config/firebase_config.js`: empty deployment placeholders; never commit real values.
- `firestore.rules`, `storage.rules`: deny-by-default starter rules. They require independent staging validation; they are not a substitute for a security review.
- `docs/v6_data_schema.md`: Firestore, Storage, consent and trajectory contracts for the AI Core team.
- `docs/v6_frontend_architecture.md`: one-page architecture, production gates and known limitations.

See [Privacy Policy](privacy.html), [Terms of Service](terms.html), and the [aggregate dashboard](dashboard.html). No fixed retention period is set in this repository; the research controller must publish and enforce one before participant recruitment. Do not use any V5/V6 output for health decisions.

## Local development

Serve this directory over HTTP(S), rather than opening files as `file://` URLs. For example:

```sh
python3 -m http.server 8000
```

Required V5 files in the repository root are `index.html`, `preprocess_v5.js`, `neurotrace_v5.onnx`, and `scaler_config_v5.json`. ONNX Runtime Web loads from jsDelivr. The V6 collector also imports local ES modules and translation JSON files; its cloud features require the deployment Firebase setup above.

The scaler JSON provides `mean` and `scale` in channel order `x`, `y`, `pressure`, `velocity`, `dt`; the model accepts float32 `[1, 5, 256]` windows and emits a raw logit that is passed through sigmoid.

## Dataset scope and intended use

Training/report metadata identifies Wacom digitizer UCI #395 trials and mobile-app touchscreen healthy-control samples (with virtual sessions in the production run). Mouse and touchscreen inputs remain experimental domain-adaptation inputs; mouse data is not independently clinically validated. Stroke processing and V5 inference run in the browser. This is not a medical device or diagnostic tool. Consult a qualified healthcare professional for medical concerns.
