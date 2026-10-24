# NeuroTrace V6 Firestore data schema

Schema version: `v6.0`
Consent text/version: `v6.0-2026-10-24`

> This is a data-contract proposal for the AI Core and research operations teams, not a statement that a collection deployment is legally approved. Health responses and trajectories are sensitive pseudonymous research data. The Firebase configuration and research-contact address are empty in this repository, so cloud collection is offline until a reviewed project is deliberately bound.

## Collections

### `v6_consents/{consent_id}` — separate consent record

Created before the first drawing task. No trajectory or survey answers are stored in this document.

```json
{
  "consent_id": "<UUID v4>",
  "device_uuid": "<UUID v4>",
  "consent_version": "v6.0-2026-10-24",
  "consented_at": "<client ISO-8601 timestamp>",
  "age_over_18": true,
  "privacy_terms": true,
  "research_donation": true,
  "no_medical_diagnosis": true,
  "locale": "en",
  "owner_uid": "<Firebase anonymous Auth UID; access-control metadata>",
  "created_at": "<Firestore serverTimestamp>"
}
```

The identifier is referenced by `v6_sessions.consent_id`. Security rules bind the session write to an existing consent record owned by the same authenticated anonymous account. Consent text is versioned; material text changes require a new version and renewed consent.

### `v6_sessions/{session_id}` — one completed, consented protocol

A document is queued locally only after all six tasks have a completed or skipped state and the required feedback form validates. `session_id` is generated on page load. An unfinished local draft resumed after reload is rebased into the new page-load session and notes `resumed_from_session_id` in session metadata.

```json
{
  "session_id": "<UUID v4>",
  "device_uuid": "<UUID v4 stored in LocalStorage>",
  "device_fingerprint_hash": "<64 lowercase hex SHA-256 digest>",
  "consent_id": "<v6_consents document id>",
  "session_metadata": {
    "timestamp_start": "<ISO-8601>",
    "timestamp_end": "<ISO-8601>",
    "timezone": "Asia/Ho_Chi_Minh",
    "locale": "vi-VN",
    "resumed": false,
    "resumed_from_session_id": null
  },
  "demographics": {
    "health_status": "healthy_no_known_neurological_conditions | parkinsons_clinically_diagnosed | other_neurological_diagnosis | prefer_not_to_say",
    "other_neurological_condition": null,
    "years_since_diagnosis": null,
    "hoehn_yahr_stage": null,
    "medications": [],
    "age_range": "18-29 | 30-39 | 40-49 | 50-59 | 60-69 | 70-79 | 80+",
    "biological_sex": "male | female | prefer_not_to_say",
    "handedness": "left | right | ambidextrous",
    "dominant_hand_used": true,
    "tremor_conditions": [],
    "other_tremor_condition": null,
    "caffeine_last_2h": "yes | no | unsure",
    "alcohol_last_4h": "yes | no",
    "fatigue_level": 1,
    "self_reported_device": "phone | tablet | laptop_touchpad | mouse | stylus_tablet | wacom_tablet | other",
    "country": "VN"
  },
  "device_info": {
    "userAgent": "<browser user agent>",
    "screenWidth": 1920,
    "screenHeight": 1080,
    "devicePixelRatio": 1,
    "pointerType": "pen | touch | mouse | unknown",
    "hasTouch": true,
    "hasStylus": false,
    "maxTouchPoints": 5,
    "estimated_sampling_rate_hz": 120.4
  },
  "tasks": [
    {
      "task_id": "archimedes_spiral",
      "task_version": "v1",
      "duration_ms": 4200.5,
      "point_count": 512,
      "trajectory": [[12.25, 34.5, 2384912, null, null, null, null, "mouse", 1, 1, 1, 1, true, 0]],
      "canvas_size": {"w": 840, "h": 360},
      "v5_inference_result": {"probability": 0.62, "classification": "positive"},
      "skipped": false
    }
  ],
  "client_created_at": "<client ISO-8601 timestamp>",
  "created_at": "<Firestore serverTimestamp>",
  "schema_version": "v6.0",
  "owner_uid": "<Firebase anonymous Auth UID; private access-control metadata>"
}
```

The example is illustrative only; the application does not create or upload sample records. A live session contains exactly six task entries. Skipped tasks have `skipped: true`, `point_count: 0`, an empty trajectory, zero canvas dimensions if no drawing occurred, and an unavailable V5 inference result.

### `v6_public_stats/current` — separately generated aggregates

This is the only document available to unauthenticated dashboard reads. It must be written by a trusted administrative process or reviewed Cloud Function, never by browser clients. The frontend expects fields such as:

```json
{
  "total_sessions": 125,
  "updated_at": "<Firestore Timestamp>",
  "device_type_counts": {"phone": 35, "mouse": 50, "stylus_tablet": 40},
  "health_status_counts": {"healthy_no_known_neurological_conditions": 70, "prefer_not_to_say": 55},
  "country_counts": [{"country": "VN", "count": 45}],
  "daily_submissions": [{"date": "2026-10-24", "count": 8}]
}
```

Never publish raw session documents, device UUIDs, fingerprints, free text, or exact location. Suppress cells smaller than five and review combinations for re-identification risk before publishing. The browser applies an additional small-cell display threshold but is not the disclosure-control authority.

## Trajectory tuple (version 1)

Every raw pointer sample is an ordered 14-value array. No smoothing, interpolation, or event-rate throttling is applied by the collector. Pointer event coalesced samples are recorded when the browser exposes them; drawing is rendered on `requestAnimationFrame` independently of sample capture.

| Index | Value | Unit / meaning |
|---:|---|---|
| 0 | `x` | CSS pixels from task-canvas left edge |
| 1 | `y` | CSS pixels from task-canvas top edge |
| 2 | `t_us` | Integer microseconds from `performance.now()` in the capture page's monotonic clock |
| 3 | `pressure` | Native PointerEvent pressure when available for non-mouse input; `null` when unavailable / mouse |
| 4 | `tiltX` | Native degrees, otherwise `null` |
| 5 | `tiltY` | Native degrees, otherwise `null` |
| 6 | `twist` | Native degrees, otherwise `null` |
| 7 | `pointerType` | Browser PointerEvent string |
| 8 | `pointerId` | Browser pointer id, otherwise `null` |
| 9 | `buttons` | Native button bitmask, otherwise `null` |
| 10 | `width` | Native pointer contact width, otherwise `null` |
| 11 | `height` | Native pointer contact height, otherwise `null` |
| 12 | `isPrimary` | Native primary-pointer boolean |
| 13 | `strokeIndex` | Zero-based stroke segment; preserves pen lifts between separate strokes |

`performance.now()` precision is browser-dependent and may be reduced by privacy settings; microsecond integer representation does not guarantee microsecond sensor accuracy. `pointerId`, `pointerType`, user-agent, and hashed fingerprint are not cross-browser stable identifiers.

## V5 inference fields

Each non-skipped task runs the existing V5 preprocessing/model path when the signal has enough valid samples and the local ONNX runtime/model are available. `probability` is the arithmetic mean of per-window model probabilities (V5 model output activation followed by existing V5 aggregation); `classification` is `positive`, `negative`, or `unavailable`, using the configured 0.50 threshold. These are model outputs, not a patient label or diagnosis. No result is forced for skipped or failed tasks.

## Large trajectories and storage

`v6_sessions` has a 1 MiB Firestore document limit. The client offloads any task trajectory larger than 1 MiB and also offloads the largest trajectories as needed to keep the Firestore document below an 800 KiB safety threshold. It uploads compact JSON to a private Storage path:

`v6_trajectories/{anonymous_auth_uid}/{session_id}/{task_id}.json`

The Firestore task retains `trajectory: null`, `trajectory_storage_path`, and `trajectory_format: "json"`. The client deliberately does not create public download URLs. Storage uploads are idempotent at the deterministic path; a failed Firestore write can leave a private orphan object, which an administrative cleanup job should reconcile. Storage rule maximum object size is 10 MiB; larger sessions remain queued and fail visibly for operator review.

## Local queue, deletion, and retention

The consent record and completed session are separately stored in IndexedDB outbox items and synchronized in consent-first order with capped exponential backoff. Session writes use `setDoc` with stable document IDs for retry idempotency. Browser storage is not a guaranteed encrypted backup and can be evicted or cleared. Participants may clear unsent items in the UI; deleting already synchronized data requires the configured research privacy contact and a verified administrative deletion workflow. Intended research retention is five years; the operator, not the static browser app, must enforce it.

## Access control and deployment requirements

`firestore.rules` denies by default, rejects client list operations, binds records to Firebase Anonymous Auth UIDs, ties session creation to an owned consent, and exposes only `v6_public_stats/current` publicly. `storage.rules` restricts trajectory objects to the authenticated UID's path. Deploy and test both rule sets in a staging Firebase project before any real collection. Enable abuse controls, evaluate Firebase App Check, monitor rules and quotas, and maintain a verified retention/deletion process. No Firestore or Storage rules emulator test was run in this repository-only environment.
