# 0002: Photo-based localization for public users

Status: accepted · 2026-10-12

## Decision

"Where am I" works by matching one camera photo from the webapp against keyframes from approved scans (image retrieval, then local feature matching and pose solve), returning level, position, heading and confidence.

## Why

- GPS fails underground. iOS Safari cannot scan Wi-Fi or Bluetooth beacons.
- The scans contributors already collect double as the reference data, so no separate survey or hardware is needed.

## Consequences

- Positions are discrete fixes, not continuous tracking. The dot stays at the last fix between photos.
- Fallbacks: tap a nearby landmark ("I'm at"), or QR codes at junctions if landlords agree.
- Query photos are deleted as soon as the pose is returned and are never logged (see 0005).
- Check licences of retrieval and matching models before use; some popular ones are non-commercial.
- Target: correct level, within about 5 m, under 3 s. Validate in phase 4.
