import os

/// The module's device log (ADR 0007): `os.Logger`, never `print`, which doesn't reach the device
/// log. Messages name states, files and frames, never poses, times or fixes; anything
/// interpolated that could carry one uses `privacy: .private` (ADR 0005).
let captureLog = Logger(subsystem: "com.xennion.usg.mapper", category: "capture")
