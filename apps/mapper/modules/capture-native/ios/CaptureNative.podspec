# The Expo module: ARKit, the camera view and its cover, and the bindings (ADR 0007). Only the
# app build compiles it; the pure-Swift targets are their own pods (../CaptureCore.podspec).
# No third-party pods.
Pod::Spec.new do |s|
  s.name           = 'CaptureNative'
  s.version        = '0.1.0'
  s.summary        = 'Underground SG capture module: ARKit session, camera view, privacy cover'
  s.license        = 'UNLICENSED'
  s.author         = 'Underground SG'
  s.homepage       = 'https://github.com/zenion/underground-sg'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/zenion/underground-sg.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'CaptureCore'
  s.frameworks     = 'ARKit', 'RealityKit'

  s.source_files   = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
