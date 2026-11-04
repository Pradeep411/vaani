// macOS ONLY. Cannot compile on Linux; verified by the macOS CI job and by a
// real call on a Mac (see README-DESKTOP.md, "Checks on a real Mac").
//
// MicCapture       AVAudioEngine input -> 16 kHz mono Float.
// ProcessTapCapture Core Audio process tap (macOS 14.2+) inside a private
//                  aggregate device -> 16 kHz mono Float. Unmuted, so the user
//                  still hears the call. Needs NSAudioCaptureUsageDescription;
//                  macOS asks for "System Audio Recording" the first time the
//                  device starts (Apple: "Capturing system audio with Core
//                  Audio taps"). No Screen Recording permission is involved.
#if os(macOS)
import AVFoundation
import CoreAudio
import Foundation
import VaaniCore

enum CaptureError: Error, CustomStringConvertible {
    case noMicrophone
    case coreAudio(String, OSStatus)
    case unsupportedFormat

    var description: String {
        switch self {
        case .noMicrophone: return "No microphone available"
        case .coreAudio(let step, let status): return "\(step) failed (\(status))"
        case .unsupportedFormat: return "Unsupported tap format"
        }
    }
}

// MARK: - Microphone

final class MicCapture {
    private let engine = AVAudioEngine()
    private var running = false
    /// Called on the audio thread with 16 kHz mono samples.
    var onSamples: (@Sendable ([Float]) -> Void)?

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.noMicrophone }
        let resampler = StreamingResampler(inputRate: format.sampleRate)
        let sink = onSamples
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            let out = resampler.process(MicCapture.mono(buffer))
            if !out.isEmpty { sink?(out) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
    }

    static func mono(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let data = buffer.floatChannelData else { return [] }
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        if buffer.format.isInterleaved {
            return Downmix.interleavedToMono(UnsafeBufferPointer(start: data[0], count: frames * channels), channels: channels)
        }
        return Downmix.planarToMono((0..<channels).map { Array(UnsafeBufferPointer(start: data[$0], count: frames)) })
    }
}

// MARK: - System audio tap

@available(macOS 14.2, *)
final class ProcessTapCapture {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "vaani.tap.io", qos: .userInteractive)
    /// Called on the tap queue with 16 kHz mono samples.
    var onSamples: (@Sendable ([Float]) -> Void)?
    private(set) var plan: TapPlan?

    deinit { stop() }

    func start(plan: TapPlan) throws {
        stop()
        self.plan = plan

        // 1. Describe the tap. Process lists are Core Audio process object
        //    IDs, not PIDs. Initializers as in Apple's CATapDescription API.
        let description: CATapDescription
        switch plan {
        case .processes(let ids):
            description = CATapDescription(monoMixdownOfProcesses: ids)            // only these
        case .systemWideExcluding(let ids):
            description = CATapDescription(monoGlobalTapButExcludeProcesses: ids)  // all but these
        }
        description.isPrivate = true
        description.muteBehavior = .unmuted        // the user keeps hearing the call
        description.name = "Vaani call audio"

        var newTap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &newTap)
        guard status == noErr else { throw CaptureError.coreAudio("Create tap", status) }
        tapID = newTap

        // 2. Read the tap's stream format.
        var formatAddress = CoreAudioRead.address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &size, &asbd)
        guard status == noErr else { stop(); throw CaptureError.coreAudio("Read tap format", status) }
        let isFloat32 = asbd.mFormatID == kAudioFormatLinearPCM
            && (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
            && asbd.mBitsPerChannel == 32
        guard isFloat32, asbd.mSampleRate > 0 else { stop(); throw CaptureError.unsupportedFormat }
        let interleavedChannels = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
            ? 1 : max(Int(asbd.mChannelsPerFrame), 1)

        // 3. Private aggregate device that contains the tap (pattern from
        //    Apple's sample and insidegui/AudioCap).
        guard let outputID = CoreAudioRead.defaultDevice(kAudioHardwarePropertyDefaultSystemOutputDevice),
              let outputUID = CoreAudioRead.string(outputID, kAudioDevicePropertyDeviceUID) else {
            stop(); throw CaptureError.coreAudio("Find output device", -1)
        }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Vaani call audio",
            kAudioAggregateDeviceUIDKey: "io.github.pradeep411.vaani.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString
            ]]
        ]
        var newAggregate = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &newAggregate)
        guard status == noErr else { stop(); throw CaptureError.coreAudio("Create aggregate device", status) }
        aggregateID = newAggregate
        // A new aggregate device may not be ready at once; wait up to ~300 ms.
        for _ in 0..<15 where (CoreAudioRead.uint32(aggregateID, kAudioDevicePropertyDeviceIsAlive) ?? 0) == 0 {
            usleep(20_000)
        }

        // 4. IO callback. The tap's stream is the last input buffer (any input
        //    streams of the output sub-device come first). Verify on device.
        let resampler = StreamingResampler(inputRate: asbd.mSampleRate)
        let sink = onSamples
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, inInputData, _, _, _ in
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard let buffer = list.last, let raw = buffer.mData, buffer.mDataByteSize > 0 else { return }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            let samples = UnsafeBufferPointer(start: raw.assumingMemoryBound(to: Float.self), count: count)
            let channels = max(Int(buffer.mNumberChannels), interleavedChannels)
            let mono = channels > 1 ? Downmix.interleavedToMono(samples, channels: channels) : Array(samples)
            let out = resampler.process(mono)
            if !out.isEmpty { sink?(out) }
        }
        guard status == noErr, procID != nil else { stop(); throw CaptureError.coreAudio("Create IO proc", status) }

        // 5. Start. The first start triggers the macOS permission prompt.
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else { stop(); throw CaptureError.coreAudio("Start tap", status) }
    }

    func stop() {
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }
}

/// Lock-protected "heard real sound since last check" flag, set from the tap
/// thread and read by the main thread.
final class SoundFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var heard = false
    func mark() { lock.lock(); heard = true; lock.unlock() }
    func take() -> Bool { lock.lock(); defer { heard = false; lock.unlock() }; return heard }
}
#endif
