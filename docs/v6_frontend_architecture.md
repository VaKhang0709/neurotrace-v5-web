# NeuroTrace V6 frontend architecture

**Status:** consent-based collection interface implemented; Firebase project binding intentionally empty; cloud collection is offline by default. This document describes the browser-only frontend and its operational boundary. It is not a claim of production certification, clinical validation, GDPR compliance, or zero data loss.

## Entry points and boundaries

- `index.html` remains the existing V5 inference demo and links to the V6 protocol. Its existing ONNX inference pipeline and `preprocess_v5.js` are preserved.
- `collect.html` is the V6 adult-only guided research collector. It requires a secure browser context, JavaScript modules, Web Crypto, LocalStorage, and IndexedDB. It blocks task access until the four consent checkboxes are completed.
- `dashboard.html` reads one public aggregate document only. It never queries `v6_sessions`; it has no direct access to participant records.
- `privacy.html` and `terms.html` are legal templates. The operator identity, monitored deletion contact, Firebase project/region, and reviewed legal terms must be supplied before enabling cloud collection.
- `config/firebase_config.js` exports empty Firebase fields and empty controller/contact values. Do not add real project config to the repository. A deployment-owned process must fill the web-app configuration, legal controller name/address, and monitored contact before collection can become enabled.

## Browser modules

- `src/v6_collector.js` owns the consent flow, UUID/fingerprint generation, task protocol, per-task pointer capture, V5 task scoring, feedback validation, draft recovery, offline queueing, retry scheduler, locale switch, and accessibility controls.
- `src/local_store.js` wraps IndexedDB stores `outbox` and `drafts`. Consent and completed sessions are saved locally before synchronization. Draft snapshots are written periodically during capture and at task transitions.
- `src/firebase_client.js` lazily imports Firebase JS SDK 10.14.1 modular packages from Google-hosted ES modules. It initializes Auth anonymously, Firestore, Storage, and (only after consent) Analytics. It uses private Storage paths for large trajectories and never creates a public object URL.
- `preprocess_v5.js` remains the shared V5 preprocessing path. Each completed non-skipped task is passed through it for optional drift-analysis inference. The threshold remains the configured 0.50; V5 aggregation is arithmetic mean of per-window probabilities.
- `i18n/en.json` and `i18n/vi.json` provide the English/Vietnamese UI translation skeleton. Country display names use `Intl.DisplayNames` where available.

## Consent and data lifecycle

1. On page load, a page-session UUID is generated using `crypto.randomUUID()` or secure `getRandomValues()` fallback. No identity or drawing is sent before consent.
2. Consent requires adult confirmation, privacy/terms agreement, research donation agreement, and acknowledgment that this is not diagnosis. The consent record has its own UUID and contains no trajectory. Local queue persistence must succeed before tasks are unlocked.
3. After consent, the collector persists a random `neurotrace_device_uuid` and a SHA-256 digest of screen resolution + user-agent + timezone under `neurotrace_device_fp`. These are pseudonymous identifiers, not anonymous data. Session metadata records start timestamp, timezone, and browser locale.
4. Each of six task canvases records raw PointerEvents immediately, including coalesced events where available. Rendering uses `requestAnimationFrame`; capture is not throttled. Pressure is `null` for mouse or when native pressure is unavailable. Stroke segment, pointer type/id, button state, tilt, twist, contact dimensions, and primary state are preserved in tuple columns.
5. Task drafts are saved to local IndexedDB. On reload, an unfinished draft may be resumed after fresh consent; its unsubmitted trajectories are rebased into the new page-load session id and the origin draft id is kept in metadata.
6. After all tasks are complete or skipped and the survey validates, the participant's completed session is queued. The sync loop writes consent first, then session. Network failures preserve the queue and retry with capped exponential backoff.
7. Each task may include the existing V5 inference probability and positive/negative/unavailable output. These are model outputs only, not clinical labels.

## Firebase boundary and dashboard data

The default empty config displays **Data collection offline**. When Firebase and research-contact details are deliberately configured, the client uses anonymous Firebase Auth, writes consent/session documents, and uploads large trajectories to private Storage. `firestore.rules` and `storage.rules` are deny-by-default; deploy and validate them in a staging project before a real data collection. No rules emulator or live Firebase project was used for these changes.

`v6_public_stats/current` is a separate, read-only public interface for the dashboard. A trusted server-side job must generate this document from private records, apply small-cell suppression (minimum five, plus re-identification review), avoid free text and identifiers, and document aggregate freshness. The web client cannot publish this document.

## Known limitations and production gates

- Browser APIs, event delivery, timestamp resolution, IndexedDB quota/eviction, crashes, power loss, or user-cleared storage can lose data. The UI saves drafts and queues completed payloads, but no browser-only design can guarantee zero data loss. A native/server-side durable capture layer would be required for stronger guarantees.
- IndexedDB is not guaranteed encrypted at rest. A browser fingerprint can still be linkable. Use participant-facing study documentation, retention/deletion processes, and deployment access controls.
- Browser-generated SHA-256 fingerprint has no secret salt and is intentionally reproducible for the specified inputs; it must not be described as irreversible anonymization.
- Firebase Analytics initializes only after the consent flow, and the application sends no trajectory or survey values as Analytics parameters. The operator must review SDK defaults, consent language, data residency, and provider terms before deployment.
- The country field is self-reported. No GPS lookup or precise geographic data is requested.
- The canvas 10 cm line is only a CSS-pixel approximation and is not physically calibrated. Touch, mouse, and stylus domains are not equivalent.
- The UI and Firebase rules require independent accessibility, security, legal, privacy, research-protocol, and mobile-device testing. The privacy/terms pages intentionally block claims of compliance until controller/contact/configuration are provided.

## Validation performed in this repository

Static JavaScript syntax and JSON checks, source/HTML ID checks, mock UI-flow checks where available, and exact numeric parity of V5 preprocessing against the pre-V6 branch were run. A browser-based Firebase emulator, real Firebase submission, visual breakpoint suite, assistive-technology audit, legal review, and high-volume pointer performance test were not run. No sample data was uploaded.
