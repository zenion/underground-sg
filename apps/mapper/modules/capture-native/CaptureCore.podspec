# CaptureCore as its own pod, so it is its own Swift module in the app build too and `internal`
# means the same on the phone as under `swift test` (ADR 0007). Foundation only. Package.swift and
# Tests/ are for `swift test` and never compiled into the app. usg-recorder.rb gives it the
# recorder switch (USG_RECORDER) and -O, as every pod of the module.
require_relative 'usg-recorder'

Pod::Spec.new do |s|
  s.name           = 'CaptureCore'
  s.version        = '0.1.0'
  s.summary        = 'Underground SG capture core: the candidate gate and the pure-Swift capture logic'
  s.license        = 'UNLICENSED'
  s.author         = 'Underground SG'
  s.homepage       = 'https://github.com/zenion/underground-sg'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/zenion/underground-sg.git' }
  s.static_framework = true

  s.source_files   = 'Sources/CaptureCore/**/*.swift'
  s.exclude_files  = ['Package.swift', 'Tests/**/*']
  s.pod_target_xcconfig = usg_xcconfig
end
