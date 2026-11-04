import Foundation

/// Target format for everything sent to the web app.
public enum VaaniAudioFormat {
    public static let sampleRate: Double = 16_000
    public static let channels = 1
    /// 250 ms per chunk.
    public static let chunkFrames = 4_000
}

// MARK: - Channel down-mix

public enum Downmix {
    /// Interleaved frames (L R L R ...) -> mono by averaging.
    public static func interleavedToMono(_ samples: UnsafeBufferPointer<Float>, channels: Int) -> [Float] {
        guard channels > 1 else { return Array(samples) }
        let frames = samples.count / channels
        var out = [Float](repeating: 0, count: frames)
        let scale = 1 / Float(channels)
        for f in 0..<frames {
            var acc: Float = 0
            let base = f * channels
            for c in 0..<channels { acc += samples[base + c] }
            out[f] = acc * scale
        }
        return out
    }

    /// Separate channel buffers -> mono by averaging.
    public static func planarToMono(_ channels: [[Float]]) -> [Float] {
        guard let first = channels.first else { return [] }
        guard channels.count > 1 else { return first }
        let frames = channels.map(\.count).min() ?? 0
        var out = [Float](repeating: 0, count: frames)
        let scale = 1 / Float(channels.count)
        for ch in channels {
            for i in 0..<frames { out[i] += ch[i] }
        }
        for i in 0..<frames { out[i] *= scale }
        return out
    }
}

// MARK: - Resampler

/// Streaming sample-rate converter to 16 kHz mono. Anti-alias low-pass
/// (two cascaded RBJ biquads, ~7 kHz) then linear interpolation. Good enough
/// for speech-to-text, cheap, no AVFoundation dependency, state carried across
/// chunks so there are no clicks at chunk joins.
public final class StreamingResampler: @unchecked Sendable {
    public let inputRate: Double
    public let outputRate: Double
    private let step: Double            // input samples per output sample
    private var position: Double = 0    // fractional read position into `pending`
    private var pending: [Float] = []   // filtered input not yet fully consumed
    private var filters: [Biquad]

    public init(inputRate: Double, outputRate: Double = VaaniAudioFormat.sampleRate) {
        precondition(inputRate > 0 && outputRate > 0)
        self.inputRate = inputRate
        self.outputRate = outputRate
        self.step = inputRate / outputRate
        if inputRate > outputRate {
            let cutoff = min(outputRate * 0.45, 7_200)
            filters = [Biquad.lowPass(sampleRate: inputRate, cutoff: cutoff, q: 0.5412),
                       Biquad.lowPass(sampleRate: inputRate, cutoff: cutoff, q: 1.3066)]
        } else {
            filters = []
        }
    }

    public func process(_ input: [Float]) -> [Float] {
        if input.isEmpty { return [] }
        var x = input
        for i in filters.indices { filters[i].process(&x) }
        if step == 1 { return x }
        pending.append(contentsOf: x)
        var out: [Float] = []
        out.reserveCapacity(Int(Double(pending.count) / step) + 1)
        // Need pending[i] and pending[i+1] for interpolation.
        while position + 1 < Double(pending.count) {
            let i = Int(position)
            let frac = Float(position - Double(i))
            out.append(pending[i] + (pending[i + 1] - pending[i]) * frac)
            position += step
        }
        let consumed = min(Int(position), pending.count)
        if consumed > 0 {
            pending.removeFirst(consumed)
            position -= Double(consumed)
        }
        return out
    }
}

public struct Biquad {
    var b0, b1, b2, a1, a2: Float
    var z1: Float = 0, z2: Float = 0

    public static func lowPass(sampleRate: Double, cutoff: Double, q: Double) -> Biquad {
        let w0 = 2 * Double.pi * cutoff / sampleRate
        let alpha = sin(w0) / (2 * q)
        let cosw = cos(w0)
        let a0 = 1 + alpha
        return Biquad(b0: Float((1 - cosw) / 2 / a0),
                      b1: Float((1 - cosw) / a0),
                      b2: Float((1 - cosw) / 2 / a0),
                      a1: Float(-2 * cosw / a0),
                      a2: Float((1 - alpha) / a0))
    }

    // Transposed direct form II.
    mutating func process(_ x: inout [Float]) {
        for i in x.indices {
            let input = x[i]
            let y = b0 * input + z1
            z1 = b1 * input - a1 * y + z2
            z2 = b2 * input - a2 * y
            x[i] = y
        }
    }
}

// MARK: - Mixer

public enum AudioSourceKind: String, Sendable, CaseIterable {
    case mic
    case app
}

/// Mixes the mic and the call app's audio (both already 16 kHz mono) into one
/// stream. Thread-safe: audio threads call `append`, a timer calls `drain`.
/// If one source stalls for longer than `maxLagFrames`, it is treated as
/// silence so the other side is never held back for long.
public final class AudioMixer: @unchecked Sendable {
    private let lock = NSLock()
    private var queues: [AudioSourceKind: [Float]] = [:]
    private var active: Set<AudioSourceKind>
    public let maxLagFrames: Int
    /// Hard cap per queue (protects memory if drain stops being called).
    public let maxQueuedFrames: Int

    public init(sources: Set<AudioSourceKind>, maxLagFrames: Int = 8_000, maxQueuedFrames: Int = 16_000 * 30) {
        self.active = sources
        self.maxLagFrames = maxLagFrames
        self.maxQueuedFrames = maxQueuedFrames
        for s in sources { queues[s] = [] }
    }

    public func append(_ source: AudioSourceKind, _ samples: [Float]) {
        lock.lock(); defer { lock.unlock() }
        guard active.contains(source) else { return }
        queues[source, default: []].append(contentsOf: samples)
        if let count = queues[source]?.count, count > maxQueuedFrames {
            queues[source]?.removeFirst(count - maxQueuedFrames)
        }
    }

    /// Stop waiting for a source (e.g. the app tap failed mid-call).
    public func deactivate(_ source: AudioSourceKind) {
        lock.lock(); defer { lock.unlock() }
        active.remove(source)
        queues[source] = nil
    }

    public var activeSources: Set<AudioSourceKind> {
        lock.lock(); defer { lock.unlock() }
        return active
    }

    /// Returns mixed samples that are ready. `flush` empties everything.
    public func drain(flush: Bool = false) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let live = active.sorted { $0.rawValue < $1.rawValue }
        guard !live.isEmpty else { return [] }
        let counts = live.map { queues[$0]?.count ?? 0 }
        let longest = counts.max() ?? 0
        let shortest = counts.min() ?? 0
        let n = flush ? longest : max(shortest, longest - maxLagFrames)
        guard n > 0 else { return [] }
        var out = [Float](repeating: 0, count: n)
        for s in live {
            guard var q = queues[s] else { continue }
            let take = min(n, q.count)
            for i in 0..<take { out[i] += q[i] }
            q.removeFirst(take)
            queues[s] = q
        }
        if live.count > 1 {
            for i in out.indices { out[i] = min(max(out[i], -1), 1) }
        }
        return out
    }
}

// MARK: - PCM

public enum PCM16 {
    /// Float [-1, 1] -> signed 16-bit little-endian bytes.
    public static func encode(_ samples: [Float]) -> Data {
        var data = Data(count: samples.count * 2)
        data.withUnsafeMutableBytes { raw in
            let p = raw.bindMemory(to: UInt8.self)
            for (i, s) in samples.enumerated() {
                let clamped = s.isFinite ? min(max(s, -1), 1) : 0
                let v = Int16(clamped < 0 ? (clamped * 32768).rounded() : (clamped * 32767).rounded())
                let u = UInt16(bitPattern: v)
                p[i * 2] = UInt8(u & 0xFF)
                p[i * 2 + 1] = UInt8(u >> 8)
            }
        }
        return data
    }

    public static func decode(_ data: Data) -> [Int16] {
        let bytes = [UInt8](data)
        var out = [Int16](repeating: 0, count: bytes.count / 2)
        for i in out.indices {
            out[i] = Int16(bitPattern: UInt16(bytes[i * 2]) | (UInt16(bytes[i * 2 + 1]) << 8))
        }
        return out
    }
}

// MARK: - Chunker

/// Collects mixed samples and cuts them into fixed 250 ms chunks.
public struct Chunker {
    public let chunkFrames: Int
    private var buffer: [Float] = []

    public init(chunkFrames: Int = VaaniAudioFormat.chunkFrames) { self.chunkFrames = chunkFrames }

    public mutating func push(_ samples: [Float]) -> [[Float]] {
        buffer.append(contentsOf: samples)
        var chunks: [[Float]] = []
        while buffer.count >= chunkFrames {
            chunks.append(Array(buffer.prefix(chunkFrames)))
            buffer.removeFirst(chunkFrames)
        }
        return chunks
    }

    /// The last partial chunk at the end of a session.
    public mutating func flush() -> [Float]? {
        guard !buffer.isEmpty else { return nil }
        defer { buffer.removeAll() }
        return buffer
    }
}

// MARK: - Replay buffer

/// Keeps a session's chunks in memory so the web page can catch up after it
/// loads (or reloads). Never written to disk. Oldest chunks drop past the cap.
public final class ReplayBuffer {
    public struct Chunk: Equatable { public let seq: Int; public let data: Data }
    public let maxBytes: Int
    private var chunks: [Chunk] = []
    private var bytes = 0

    /// Default cap: 30 minutes of 16 kHz 16-bit mono (about 58 MB).
    public init(maxBytes: Int = 16_000 * 2 * 60 * 30) { self.maxBytes = maxBytes }

    public func append(seq: Int, data: Data) {
        chunks.append(Chunk(seq: seq, data: data))
        bytes += data.count
        while bytes > maxBytes, !chunks.isEmpty {
            bytes -= chunks.removeFirst().data.count
        }
    }

    public func chunks(fromSeq seq: Int) -> [Chunk] { chunks.filter { $0.seq >= seq } }
    public var oldestSeq: Int? { chunks.first?.seq }
    public var byteCount: Int { bytes }

    /// Wipe audio (after notes are made, on quit, or after the keep window).
    public func clear() {
        chunks.removeAll()
        bytes = 0
    }
}
