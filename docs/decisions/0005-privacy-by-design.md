# 0005: Privacy by design

Status: accepted · 2026-10-12

## Decision

- Faces and screens are blurred on the phone before any image is written to a capture bundle.
- Ingest re-runs detection and rejects any bundle with an unblurred face.
- Raw capture bundles stay in private storage; only derived, re-checked landmark crops are ever public.
- Localization query photos are processed in memory, deleted once the pose is returned, and never logged.
- Only public walkways are published. No back-of-house, plant rooms or security features.

## Why

Identifiable faces are personal data under Singapore's PDPA, and landlords will only grant scanning permission if the project is visibly careful.

## Consequences

Any code that touches images must keep these guarantees. Treat a violation as a release blocker, and add a test whenever an image path changes.
