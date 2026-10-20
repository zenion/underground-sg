# Planted calls for the encoder check's self-test

The macOS CI job compiles each Swift file here for iOS on its own and runs the encoder check on
it with an empty allow-list (`node apps/mapper/scripts/encoder-check.mts --self-test <this dir>`,
ADR 0010). A file whose first line is `// expect: <rule>` must be caught by that rule (`|`
separates alternatives); `Clean.swift` must pass. None of these files is in a pod or a SwiftPM
target, so none reaches the app.
