# CaptureIO as its own pod, beside CaptureCore (design 2 and 3.2): durable files, SHA-256,
# DEFLATE and atomic documents for the recorder, and later for bundles. Foundation, Compression
# and CryptoKit, no third-party pods. Package.swift, Tests/ and Sources/capture-synth are for
# `swift test` and the PC, never compiled into the app; nor are the pure-Swift fallbacks, which
# only Package.swift's USG_IO_FALLBACKS or a platform without CryptoKit and Compression compiles.
Pod::Spec.new do |s|
  s.name           = 'CaptureIO'
  s.version        = '0.1.0'
  s.summary        = 'Underground SG capture I/O: durable files, hashing and compression for recordings'
  s.license        = 'UNLICENSED'
  s.author         = 'Underground SG'
  s.homepage       = 'https://github.com/zenion/underground-sg'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/zenion/underground-sg.git' }
  s.static_framework = true

  s.dependency 'CaptureCore'
  s.frameworks     = 'Compression', 'CryptoKit'

  s.source_files   = 'Sources/CaptureIO/**/*.swift'
  s.exclude_files  = ['Package.swift', 'Tests/**/*', 'Sources/capture-synth/**/*']
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
