// macOS ONLY (kept inside #if so the Linux stub build stays empty).
#if os(macOS)
import Foundation

/// Weak, Sendable handle to a main-actor object, for Timer, GCD, KVO,
/// NSEvent-monitor and Core Audio callbacks. Those callbacks are @Sendable or
/// plain C blocks; capturing `self` (a @MainActor class) in them directly is
/// what Swift 6 strict concurrency rejects. The callback captures the relay,
/// hops with MainActor.assumeIsolated (every such callback here is delivered
/// on the main thread), and only then reads `owner`.
final class MainActorRelay<Owner: AnyObject>: @unchecked Sendable {
    private weak var _owner: Owner?
    init(_ owner: Owner) { _owner = owner }
    @MainActor var owner: Owner? { _owner }
}

/// A repeating timer on the main run loop in `.common` modes, so it keeps
/// firing while a menu is open or a modal panel runs (security audit L-01).
@MainActor
func makeCommonModeTimer(interval: TimeInterval, tolerance: TimeInterval = 0.05,
                         _ fire: @escaping @Sendable () -> Void) -> Timer {
    let timer = Timer(timeInterval: interval, repeats: true) { _ in fire() }
    timer.tolerance = tolerance
    RunLoop.main.add(timer, forMode: .common)
    return timer
}
#endif
