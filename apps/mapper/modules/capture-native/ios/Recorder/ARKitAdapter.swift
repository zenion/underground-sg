#if USG_RECORDER
  import ARKit
  import CaptureCore
  import Foundation

  /// The recorder's reads of ARKit (the lean recorder design, sections 3.1, 5 and 8): an
  /// ARFrame's values copied into CaptureCore's FrameSample, the session's anchors as
  /// AnchorSnapshots with the mesh geometry asked for, and the configuration as recording.json's
  /// `arkit`. The ARSession's delegate itself is CaptureLoop (CaptureSession.swift), which every
  /// build has; with the recorder it hands each frame to RecorderHost, which calls these.
  ///
  /// Called only inside a delegate callback on `Queues.capture`, or with the frame
  /// `session.currentFrame` gave on that queue: an ARFrame or ARAnchor is read here and released
  /// when the callback returns. Nothing here keeps one or logs a value.
  enum ARKitAdapter {
    /// The name `markAnchor` gives the ARAnchor it adds at the floor hit: `usg.marked.<role>`.
    static let markedPrefix = "usg.marked."

    /// frames.jsonl's values for one ARFrame. `candidate` is whether the candidate gate passed
    /// it: lean keeps no candidates, so a passed frame is `dropped:profile` (forced ones too).
    static func frameSample(
      _ frame: ARFrame, index: Int, t: Double, fps: Int, candidate: Bool, gateMs: Double
    ) -> FrameSample {
      let camera = frame.camera
      // The intrinsics matrix's [0][0], [1][1], [2][0] and [2][1]: fx, fy, cx and cy.
      let k = camera.intrinsics
      var light: SIMD2<Float>? = nil
      if let estimate = frame.lightEstimate {
        let intensity = Float(estimate.ambientIntensity)
        let temperature = Float(estimate.ambientColorTemperature)
        if intensity.isFinite && temperature.isFinite {
          light = SIMD2(intensity, temperature)
        }
      }
      return FrameSample(
        frame: index, t: t, camera: WorldTransform(camera.transform),
        intrinsics: SIMD4(k.columns.0.x, k.columns.1.y, k.columns.2.x, k.columns.2.y),
        tracking: trackingCode(camera.trackingState), mapping: mappingCode(frame.worldMappingStatus),
        exposureDurationS: camera.exposureDuration, exposureOffsetEV: camera.exposureOffset,
        light: light, fps: fps, candidate: candidate ? .dropped(.profile) : nil, gateMs: gateMs)
    }

    /// The camera's position, for the idle check.
    static func position(_ frame: ARFrame) -> SIMD3<Double> {
      let p = frame.camera.transform.columns.3
      return SIMD3(Double(p.x), Double(p.y), Double(p.z))
    }

    static func trackingCode(_ state: ARCamera.TrackingState) -> TrackingCode {
      switch state {
      case .normal:
        return .normal
      case .notAvailable:
        return .notAvailable
      case .limited(let reason):
        switch reason {
        case .initializing: return .limited(.initializing)
        case .excessiveMotion: return .limited(.excessiveMotion)
        case .insufficientFeatures: return .limited(.insufficientFeatures)
        case .relocalizing: return .limited(.relocalizing)
        @unknown default: return .limited(.unknown)
        }
      }
    }

    /// Whether ARKit is relocalizing, for the relocalization events.
    static func isRelocalizing(_ state: ARCamera.TrackingState) -> Bool {
      if case .limited(.relocalizing) = state { return true }
      return false
    }

    static func mappingCode(_ status: ARFrame.WorldMappingStatus) -> MappingCode {
      switch status {
      case .notAvailable: return .notAvailable
      case .limited: return .limited
      case .extending: return .extending
      case .mapped: return .mapped
      @unknown default: return .notAvailable
      }
    }

    /// The frame's anchors of the kinds anchors.jsonl samples (mesh and marked; a lean session
    /// has no keyframe or image anchors), and the geometry of the mesh anchors `request` names,
    /// copied now (design D5).
    static func reading(_ frame: ARFrame, _ request: GeometryRequest) -> AnchorReading {
      let wanted: Set<UUID>?
      switch request {
      case .none: wanted = []
      case .anchors(let ids): wanted = Set(ids)
      case .everyMeshAnchor: wanted = nil
      }
      var anchors: [AnchorSnapshot] = []
      var geometry: [UUID: MeshGeometry] = [:]
      for anchor in frame.anchors {
        if let mesh = anchor as? ARMeshAnchor {
          let id = mesh.identifier
          anchors.append(AnchorSnapshot(id: id, kind: .mesh, transform: WorldTransform(mesh.transform)))
          if wanted?.contains(id) ?? true, let copy = MeshCopier.copy(mesh.geometry) {
            geometry[id] = copy
          }
        } else if let name = anchor.name, name.hasPrefix(markedPrefix) {
          anchors.append(
            AnchorSnapshot(
              id: anchor.identifier, kind: .marked, transform: WorldTransform(anchor.transform)))
        }
      }
      return AnchorReading(anchors: anchors, geometry: geometry)
    }

    /// recording.json's `arkit` for the configuration the session runs.
    static func setup(_ configuration: ARWorldTrackingConfiguration) -> ArkitSetup {
      let reconstruction: ArkitSetup.Reconstruction
      if configuration.sceneReconstruction.contains(.meshWithClassification) {
        reconstruction = .meshWithClassification
      } else if configuration.sceneReconstruction.contains(.mesh) {
        reconstruction = .mesh
      } else {
        reconstruction = .none
      }
      var semantics: [ArkitSetup.Semantic] = []
      if configuration.frameSemantics.contains(.sceneDepth) { semantics.append(.sceneDepth) }
      if configuration.frameSemantics.contains(.smoothedSceneDepth) {
        semantics.append(.smoothedSceneDepth)
      }
      let alignment: ArkitSetup.Alignment
      switch configuration.worldAlignment {
      case .gravity: alignment = .gravity
      case .gravityAndHeading: alignment = .gravityAndHeading
      case .camera: alignment = .camera
      @unknown default: alignment = .gravity
      }
      let format = configuration.videoFormat
      return ArkitSetup(
        reconstruction: reconstruction, semantics: semantics,
        videoWidth: Int(format.imageResolution.width),
        videoHeight: Int(format.imageResolution.height), fps: format.framesPerSecond,
        alignment: alignment)
    }
  }
#endif
