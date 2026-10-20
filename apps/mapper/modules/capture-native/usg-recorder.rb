# The session recorder's build switch on the native side (ADR 0010; the lean recorder design,
# section 2). The config plugin (apps/mapper/plugins/with-usg-recorder.ts) writes
# "usg.recorder": "true" into ios/Podfile.properties.json for the development and walk builds, and
# removes it otherwise; every pod of this module requires this file and sets
# `s.pod_target_xcconfig = usg_xcconfig`, so all of them compile the recorder or none does.
#
# Also for every pod and configuration (D25): -O and whole-module compilation, so the development
# build's timings mean something and Release-only problems show up in every build.

require 'json'

# Whether Podfile.properties.json, beside the Podfile `pod install` runs, turns the recorder on.
def usg_recorder?
  props = File.join(Pod::Config.instance.installation_root.to_s, 'Podfile.properties.json')
  File.exist?(props) && JSON.parse(File.read(props))['usg.recorder'] == 'true'
end

def usg_xcconfig
  {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_OPTIMIZATION_LEVEL' => '-O',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => usg_recorder? ? '$(inherited) USG_RECORDER' : '$(inherited)'
  }
end
