// macOS ONLY. Verified by macOS CI (compile) and on a Mac (behaviour).
//
// The notes window: a WKWebView locked to https://pradeep411.github.io/vaani/.
// Audio goes in through a narrow bridge (see WEB-BRIDGE-SPEC.md):
//   native -> page: callAsyncJavaScript(dispatchScript, arguments: ["msg": ...])
//                   -> window.__VAANI_DESKTOP__._deliver(msg) -> the ONE
//                   callback the page registered with connect()
//   page -> native: window.webkit.messageHandlers.vaaniDesktop.postMessage(...)
// Every inbound message is checked: top frame only, origin exactly
// https://pradeep411.github.io, page path under /vaani/, known shape, and
// (except `ready`) the per-load nonce.
#if os(macOS)
import AppKit
import WebKit
import VaaniCore

@MainActor
final class VaaniWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
                                   WKDownloadDelegate, BridgeTransport {
    let window: NSWindow
    let webView: WKWebView
    private let bridge: BridgeSession
    private let openGate = ExternalOpenGate()
    private var backoff = ReloadBackoff()
    private var lastClickAt: TimeInterval?
    private var clickMonitor: Any?
    private var micObservation: NSKeyValueObservation?
    private var hideObserver: NSObjectProtocol?
    private var tornDown = false
    private let flavor: BuildFlavor
    /// Per-web-view secret written into the user script and passed only as a
    /// callAsyncJavaScript argument; `_deliver` refuses calls without it, so
    /// page scripts cannot fake native messages (re-audit F-01).
    private let deliverToken: String
    /// The user closed the window (as opposed to minimising it).
    private(set) var closedByUser = false

    /// The page pressed Stop.
    var onStopRequested: (() -> Void)?
    /// The page started or stopped using the microphone itself, or crashed.
    var onPageStateChange: (() -> Void)?
    /// The user closed the window.
    var onClosed: (() -> Void)?
    /// Set when the page crashed too often; shown in the menu.
    private(set) var crashNotice: String?

    /// The document-start script, read from the app bundle (single source of
    /// truth, also run by the Node tests), with this web view's delivery
    /// token written in. If it is missing or malformed, the bridge stays
    /// closed: the page never sees __VAANI_DESKTOP__.
    private static func loadUserScript(token: String) -> String? {
        guard let url = Bundle.main.url(forResource: BridgeConfig.userScriptName, withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let built = UserScriptBuilder.build(source: source, token: token) else {
            NSLog("Vaani: %@.js missing or malformed; desktop bridge disabled", BridgeConfig.userScriptName)
            return nil
        }
        return built
    }

    init(bridge: BridgeSession, flavor: BuildFlavor) {
        self.bridge = bridge
        self.flavor = flavor
        let token = UserScriptBuilder.makeToken()
        self.deliverToken = token
        let config = WKWebViewConfiguration()
        // Standard build: the default store, inside the sandbox container.
        // Diagnostic (no-sandbox) build: nothing is stored at all, so no keys
        // or notes ever land outside the sandbox (re-audit D-01).
        config.websiteDataStore = flavor.persistsWebData ? .default() : .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = true
        let content = WKUserContentController()
        if let source = Self.loadUserScript(token: token) {
            content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart,
                                               forMainFrameOnly: true, in: .page))
        }
        config.userContentController = content
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: config)
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = flavor == .diagnostic ? Copy.diagnosticWindowTitle : Copy.windowTitle
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.minSize = NSSize(width: 380, height: 480)
        window.center()
        window.setFrameAutosaveName("VaaniNotesWindow")
        super.init()

        window.delegate = self
        content.add(ScriptMessageProxy(owner: self), contentWorld: .page, name: BridgeConfig.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        bridge.attach(self)

        let relay = MainActorRelay(self)
        // Real clicks in this window (security audit L-04): a link opens in
        // the browser only right after one.
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { event in
            MainActor.assumeIsolated {
                if let owner = relay.owner, event.window === owner.window {
                    owner.lastClickAt = ProcessInfo.processInfo.systemUptime
                }
            }
            return event
        }
        // Menu-bar indicator whenever the page itself uses the mic (audit
        // M-02), and the page mic is forced off whenever the window is not on
        // screen, even if WebKit reused an earlier grant (re-audit N-04).
        micObservation = webView.observe(\.microphoneCaptureState, options: [.new]) { _, _ in
            MainActor.assumeIsolated {
                if let owner = relay.owner { owner.enforcePageMicRule() }
            }
        }
        hideObserver = NotificationCenter.default.addObserver(forName: NSApplication.didHideNotification,
                                                              object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                if let owner = relay.owner { owner.enforcePageMicRule() }
            }
        }
        webView.load(URLRequest(url: BridgeConfig.startURL))
    }

    /// Show next to the call without taking keyboard focus from it.
    func showQuietly() {
        closedByUser = false
        if !window.isVisible { window.orderFrontRegardless() }
    }

    /// Show and focus (menu "Open Vaani").
    func showAndFocus() {
        closedByUser = false
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    func setRecording(_ recording: Bool) {
        if flavor == .diagnostic {
            window.title = Copy.diagnosticWindowTitle
        } else {
            window.title = recording ? Copy.windowTitleRecording : Copy.windowTitle
        }
    }

    /// Really on screen: shown, not minimised, app not hidden.
    var isOnScreen: Bool { window.isVisible && !window.isMiniaturized && !NSApp.isHidden }

    /// Re-audit N-04: the page may use the mic only while the window is on
    /// screen. Also refreshes the menu-bar indicator.
    fileprivate func enforcePageMicRule() {
        guard !tornDown else { return }
        if NotesWindowPolicy.mustForceMicOff(pageCapturing: isCapturingMic, windowOnScreen: isOnScreen) {
            webView.setMicrophoneCaptureState(.none, completionHandler: nil)
        }
        onPageStateChange?()
    }

    /// True while the page itself is using the mic (its own dictation).
    var isCapturingMic: Bool { !tornDown && webView.microphoneCaptureState != WKMediaCaptureState.none }

    /// Stop the page completely (window closed with no session to deliver).
    func tearDown() {
        guard !tornDown else { return }
        tornDown = true
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        micObservation?.invalidate()
        micObservation = nil
        if let hideObserver { NotificationCenter.default.removeObserver(hideObserver) }
        hideObserver = nil
        webView.setMicrophoneCaptureState(.none, completionHandler: nil)
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        let content = webView.configuration.userContentController
        content.removeAllUserScripts()
        content.removeScriptMessageHandler(forName: BridgeConfig.handlerName, contentWorld: .page)
        window.delegate = nil
        window.contentView = nil
        bridge.pageWillReload()
    }

    // MARK: BridgeTransport (native -> page)

    @discardableResult
    nonisolated func send(_ message: NativeToWeb) -> Bool {
        MainActor.assumeIsolated {
            guard !tornDown, BridgeGate.maySend(to: webView.url) else { return false }
            if case .hello(let nonce) = message {
                // Re-audit N-03: the dispatch script returns whether a
                // connected listener took the message. If `hello` reached
                // nobody (someone else sent `ready` early), reset the
                // handshake so the web app's own `ready` is honoured.
                let relay = MainActorRelay(self)
                webView.callAsyncJavaScript(NativeToWeb.dispatchScript,
                                            arguments: ["msg": message.payload, "token": deliverToken],
                                            in: nil, in: .page) { result in
                    MainActor.assumeIsolated {
                        var delivered = false
                        if case .success(let value) = result, let ok = value as? Bool { delivered = ok }
                        if !delivered, let owner = relay.owner { owner.bridge.helloNotDelivered(nonce: nonce) }
                    }
                }
            } else {
                webView.callAsyncJavaScript(NativeToWeb.dispatchScript,
                                            arguments: ["msg": message.payload, "token": deliverToken],
                                            in: nil, in: .page, completionHandler: nil)
            }
            return true
        }
    }

    // MARK: Page -> native

    fileprivate func receive(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let pageURL = message.webView?.url
        guard !tornDown, message.name == BridgeConfig.handlerName,
              BridgeGate.accepts(isMainFrame: message.frameInfo.isMainFrame,
                                 origin: FrameOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
                                 pageURL: pageURL),
              let parsed = BridgeParser.parse(message.body) else { return }
        if bridge.handle(parsed.message, nonce: parsed.nonce, now: ProcessInfo.processInfo.systemUptime) {
            onStopRequested?()
        }
    }

    private func openExternallyIfClicked(_ url: URL) {
        let now = ProcessInfo.processInfo.systemUptime
        if openGate.allows(now: now, lastClickAt: lastClickAt, windowIsKey: window.isKeyWindow) {
            NSWorkspace.shared.open(url)
        }
    }

    fileprivate func reloadAfterCrash() {
        guard !tornDown else { return }
        webView.load(URLRequest(url: BridgeConfig.startURL))
    }

    // MARK: - Delegate methods
    //
    // Rules used for every WebKit / AppKit delegate method in this app:
    //  * Completion-handler form, Swift name derived mechanically from the
    //    Objective-C selector (named in the comment above each method). The
    //    async forms are NOT used: WebKit renames some of them (for example
    //    requestMediaCapturePermission... becomes decideMediaCapturePermissions...),
    //    which is how CI run #1 failed.
    //  * Handler parameters are written as plain `@escaping (T) -> Void`.
    //    Newer SDKs annotate them @MainActor @Sendable; Objective-C imports are
    //    @preconcurrency, so in Swift 5 language mode the plain form matches
    //    both the Xcode 15 and Xcode 16 SDKs.
    //  * `nonisolated` + MainActor.assumeIsolated: AppKit and WebKit always
    //    call these on the main thread. A nonisolated witness satisfies the
    //    requirement whether or not the SDK marks the protocol @MainActor.

    // MARK: NSWindowDelegate

    // windowWillClose:
    nonisolated func windowWillClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            // Closing the window ends any capture the page itself started
            // (security audit M-02).
            closedByUser = true
            webView.setMicrophoneCaptureState(.none, completionHandler: nil)
            onClosed?()
        }
    }

    // windowDidMiniaturize:
    nonisolated func windowDidMiniaturize(_ notification: Notification) {
        MainActor.assumeIsolated {
            // Minimised is not on screen: page mic off (re-audit N-04).
            webView.setMicrophoneCaptureState(.none, completionHandler: nil)
            onPageStateChange?()
        }
    }

    // MARK: WKNavigationDelegate

    // webView:decidePolicyForNavigationAction:decisionHandler:
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let policy: WKNavigationActionPolicy = MainActor.assumeIsolated {
            // Downloads count as "from our page" when the top page is ours:
            // other origins can never load in any frame (subframe navigations
            // to them are cancelled here). sourceFrame is not read: WebKit
            // can hand back nil for it despite the non-optional Swift type.
            let request = NavigationRequest(url: navigationAction.request.url,
                                            isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
                                            userInitiated: navigationAction.navigationType == .linkActivated,
                                            shouldDownload: navigationAction.shouldPerformDownload,
                                            sourceIsAllowed: NavigationPolicy.isAllowedPage(webView.url))
            switch NavigationPolicy.decide(request) {
            case .allow: return .allow
            case .download: return .download
            case .cancel: return .cancel
            case .openExternally(let url):
                // A scripted a.click() also reports linkActivated: require a
                // real recent mouse click, one open per second (audit L-04).
                openExternallyIfClicked(url)
                return .cancel
            }
        }
        decisionHandler(policy)
    }

    // webView:decidePolicyForNavigationResponse:decisionHandler:
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                             decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let policy: WKNavigationResponsePolicy = MainActor.assumeIsolated {
            // Defence in depth against redirects: the top frame must still be ours.
            if navigationResponse.isForMainFrame, !NavigationPolicy.isAllowedPage(navigationResponse.response.url) {
                return .cancel
            }
            return navigationResponse.canShowMIMEType ? .allow : .download
        }
        decisionHandler(policy)
    }

    // webView:navigationAction:didBecomeDownload:
    nonisolated func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        MainActor.assumeIsolated { download.delegate = self }
    }

    // webView:navigationResponse:didBecomeDownload:
    nonisolated func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        MainActor.assumeIsolated { download.delegate = self }
    }

    // webView:didCommitNavigation:
    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        MainActor.assumeIsolated { bridge.pageWillReload() }   // new page: new nonce, must say "ready" again
    }

    // webViewWebContentProcessDidTerminate:
    // Reload with back-off 1 s, 5 s, 30 s, then stop and say so (audit L-02).
    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        MainActor.assumeIsolated {
            bridge.pageWillReload()
            guard let delay = backoff.nextDelay(now: ProcessInfo.processInfo.systemUptime) else {
                crashNotice = Copy.pageCrashed
                onPageStateChange?()
                return
            }
            let relay = MainActorRelay(self)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                MainActor.assumeIsolated {
                    if let owner = relay.owner { owner.reloadAfterCrash() }
                }
            }
        }
    }

    // MARK: WKUIDelegate

    // webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:
    // window.open / target=_blank: never a second web view; real links go to
    // the default browser after a real click.
    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        MainActor.assumeIsolated {
            if case .openExternally(let url) = NavigationPolicy.decidePopup(navigationAction.request.url) {
                openExternallyIfClicked(url)
            }
        }
        return nil
    }

    // webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:
    // The page's own dictation may ask for the mic: WebKit shows its standard
    // prompt (.prompt, audit M-02), and only while the window is on screen.
    // Camera and every other origin: deny.
    nonisolated func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                             initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                             decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let decision: WKPermissionDecision = MainActor.assumeIsolated {
            let allowed = type == .microphone && isOnScreen && BridgeGate.accepts(
                isMainFrame: frame.isMainFrame,
                origin: FrameOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
                pageURL: webView.url)
            return allowed ? .prompt : .deny
        }
        decisionHandler(decision)
    }

    // webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:
    // Sheets, not app-modal loops, where possible (audit L-01).
    nonisolated func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        MainActor.assumeIsolated {
            let alert = NSAlert()
            alert.messageText = String(message.prefix(500))
            alert.addButton(withTitle: "OK")
            if window.isVisible {
                alert.beginSheetModal(for: window) { _ in MainActor.assumeIsolated { completionHandler() } }
            } else {
                _ = alert.runModal()
                completionHandler()
            }
        }
    }

    // webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:
    nonisolated func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        MainActor.assumeIsolated {
            let alert = NSAlert()
            alert.messageText = String(message.prefix(500))
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            if window.isVisible {
                alert.beginSheetModal(for: window) { response in
                    MainActor.assumeIsolated { completionHandler(response == .alertFirstButtonReturn) }
                }
            } else {
                completionHandler(alert.runModal() == .alertFirstButtonReturn)
            }
        }
    }

    // webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:
    // <input type=file> (importing audio or notes).
    nonisolated func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        MainActor.assumeIsolated {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
            panel.beginSheetModal(for: window) { response in
                MainActor.assumeIsolated { completionHandler(response == .OK ? panel.urls : nil) }
            }
        }
    }

    // MARK: WKDownloadDelegate (notes export)

    // download:decideDestinationUsingResponse:suggestedFilename:completionHandler:  (required)
    nonisolated func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                              suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        MainActor.assumeIsolated {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedFilename
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { response in
                MainActor.assumeIsolated {
                    guard response == .OK, let url = panel.url else {
                        completionHandler(nil)
                        return
                    }
                    try? FileManager.default.removeItem(at: url)   // the user already confirmed "Replace"
                    completionHandler(url)
                }
            }
        }
    }
}

/// Avoids a retain cycle (WKUserContentController holds handlers strongly).
@MainActor
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: VaaniWindowController?

    init(owner: VaaniWindowController) {
        self.owner = owner
        super.init()
    }

    // userContentController:didReceiveScriptMessage:  (required)
    nonisolated func userContentController(_ userContentController: WKUserContentController,
                                           didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            if let owner { owner.receive(message) }
        }
    }
}
#endif
