// macOS ONLY. Cannot compile on Linux; verified by the macOS CI job.
//
// Reads which processes are using audio input/output via the Core Audio
// process objects (macOS 14 SDK): kAudioHardwarePropertyProcessObjectList,
// kAudioProcessPropertyPID / BundleID / IsRunningInput / IsRunningOutput.
// Fallback: kAudioDevicePropertyDeviceIsRunningSomewhere on the default input
// (known to read 0 for some Bluetooth mics, Apple forums thread 741026).
#if os(macOS)
import CoreAudio
import Foundation
import VaaniCore

enum CoreAudioRead {
    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func objectIDs(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID]? {
        var addr = address(selector)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr else { return nil }
        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        if count == 0 { return [] }
        var ids = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
        let status = ids.withUnsafeMutableBytes { raw in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, raw.baseAddress!)
        }
        guard status == noErr else { return nil }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var addr = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    static func pid(_ object: AudioObjectID) -> pid_t? {
        var addr = address(kAudioProcessPropertyPID)
        var value: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    /// CFString properties are returned +1 retained; we take ownership.
    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var ref: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &ref) { p in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, p)
        }
        guard status == noErr, let ref else { return nil }
        return ref.takeRetainedValue() as String
    }

    static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
        guard let id = uint32(AudioObjectID(kAudioObjectSystemObject), selector),
              id != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return AudioObjectID(id)
    }

    static func processObject(forPID pid: pid_t) -> AudioObjectID? {
        var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                                UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
        guard status == noErr, object != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return object
    }
}

final class CoreAudioProcessSource: AudioProcessSource {
    func currentProcesses() -> [AudioProcessInfo]? {
        guard let ids = CoreAudioRead.objectIDs(AudioObjectID(kAudioObjectSystemObject),
                                                kAudioHardwarePropertyProcessObjectList) else { return nil }
        return ids.compactMap { id in
            guard let pid = CoreAudioRead.pid(id) else { return nil }
            return AudioProcessInfo(
                objectID: id,
                pid: pid,
                bundleID: CoreAudioRead.string(id, kAudioProcessPropertyBundleID),
                runningInput: (CoreAudioRead.uint32(id, kAudioProcessPropertyIsRunningInput) ?? 0) != 0,
                runningOutput: (CoreAudioRead.uint32(id, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0)
        }
    }

    func isMicRunningSomewhere() -> Bool {
        guard let mic = CoreAudioRead.defaultDevice(kAudioHardwarePropertyDefaultInputDevice) else { return false }
        return (CoreAudioRead.uint32(mic, kAudioDevicePropertyDeviceIsRunningSomewhere) ?? 0) != 0
    }
}
#endif
