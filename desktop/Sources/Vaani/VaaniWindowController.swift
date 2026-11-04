// macOS ONLY. Verified by macOS CI (compile) and on a Mac (behaviour).
//
// The notes window: a WKWebView locked to https://pradeep411.github.io/vaani/.
// Audio goes in through a narrow bridge (see WEB-BRIDGE-SPEC.md):
//   native -> page: callAsyncJavaScript(dispatchScript, arguments: ["msg": ...])
//                   which fires window 'vaani-desktop' CustomEvent
//   page -> native: window.webkit.messageHandlers.vaaniDesktop.postMessage(...)
// Every inbound message is checked: top frame only, origin exactly
// https://pradeep411.github.io, page path under /vaani/, known shape.
#if os(macOS)
import AppKit
import WebKit
import VaaniCore

@MainActor
final class VaaniWindowController: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, BridgeTransport {
    let window: NSWindow
    let webView: WKWebView
    private let bridge: BridgeSession
    /// The page pressed Stop.
    var onStopRequested: (() -> Void)?

    /// Marks the page as running inside the desktop app. Defines nothing on
    /// any other origin.
    private static let flagScript = """
    (function () {
      if (location.origin !== 'https://pradeep411.github.io' || location.pathname.indexOf('/vaani/') !== 0) return;
      Object.defineProperty(window, '__VAANI_DESKTOP__', {
        value: Object.freeze({ protocol: \(BridgeConfig.protocolVersion), platform: 'macos',
                               version: '\(VaaniIdentity.version)', handler: '\(BridgeConfig.handlerName)',
                               event: '\(BridgeConfig.eventName)' }),
        writable: false, configurable: false, enumerable: false
      });
    })();
    """

    init(bridge: BridgeSession) {
        self.bridge = bridge
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // keeps the user's on-device keys and notes between launches
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = true
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: Self.flagScript, injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        config.userContentController = content
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: config)
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Vaani"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.minSize = NSSize(width: 380, height: 480)
        window.center()
        window.setFrameAutosaveName("VaaniNotesWindow")
        super.init()

        content.add(ScriptMessageProxy(owner: self), contentWorld: .page, name: BridgeConfig.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        bridge.attach(self)
        webView.load(URLRequest(url: BridgeConfig.startURL))
    }

    /// Show next to the call without taking keyboard focus from it.
    func showQuietly() {
        if !window.isVisible { window.orderFrontRegardless() }
    }

    /// Show and focus (menu "Open Vaani").
    func showAndFocus() {
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    /// True while the page itself is using the mic (its own dictation).
    var isCapturingMic: Bool { webView.microphoneCaptureState != WKMediaCaptureState.none }

    // MARK: BridgeTransport (native -> page)

    // Delegate and protocol methods below that are synchronous are marked
    // `nonisolated` and hop with MainActor.assumeIsolated: they are always
    // called on the main thread, and this way they match the protocol whether
    // or not the SDK marks it @MainActor (Xcode 15 vs 16).
    @discardableResult
    nonisolated func send(_ message: NativeToWeb) -> Bool {
        MainActor.assumeIsolated {
            guard BridgeGate.maySend(to: webView.url) else { return false }
            webView.callAsyncJavaScript(NativeToWeb.dispatchScript, arguments: ["msg": message.payload],
                                        in: nil, in: .page, completionHandler: nil)
            return true
        }
    }

    // MARK: Page -> native

    fileprivate func receive(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let pageURL = message.webView?.url
        guard message.name == BridgeConfig.handlerName,
              BridgeGate.accepts(isMainFrame: message.frameInfo.isMainFrame,
                                 origin: FrameOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
                                 pageURL: pageURL),
              let parsed = BridgeParser.parse(message.body) else { return }
        if bridge.handle(parsed, now: ProcessInfo.processInfo.systemUptime) {
            onStopRequested?()
        }
    }

    // MARK: Navigation policy

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        // Downloads count as "from our page" when the top page is ours: other
        // origins can never load in any frame (subframe navigations to them
        // are cancelled below). sourceFrame is not read: WebKit can hand back
        // nil for it despite the non-optional Swift type.
        let sourceAllowed = NavigationPolicy.isAllowedPage(webView.url)
        let request = NavigationRequest(url: navigationAction.request.url,
                                        isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
                                        userInitiated: navigationAction.navigationType == .linkActivated,
                                        shouldDownload: navigationAction.shouldPerformDownload,
                                        sourceIsAllowed: sourceAllowed)
        switch NavigationPolicy.decide(request) {
        case .allow: return .allow
        case .download: return .download
        case .cancel: return .cancel
        case .openExternally(let url):
            NSWorkspace.shared.open(url)
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        // Defence in depth against redirects: the top frame must still be ours.
        if navigationResponse.isForMainFrame, !NavigationPolicy.isAllowedPage(navigationResponse.response.url) {
            return .cancel
        }
        return navigationResponse.canShowMIMEType ? .allow : .download
    }

    nonisolated func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        MainActor.assumeIsolated { download.delegate = self }
    }

    nonisolated func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        MainActor.assumeIsolated { download.delegate = self }
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        MainActor.assumeIsolated { bridge.pageWillReload() }   // the new page must say "ready" again
    }

    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        MainActor.assumeIsolated {
            bridge.pageWillReload()
            webView.load(URLRequest(url: BridgeConfig.startURL))
        }
    }

    // MARK: UI delegate

    /// window.open / target=_blank: open real links in the default browser.
    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        MainActor.assumeIsolated {
            if case .openExternally(let url) = NavigationPolicy.decidePopup(navigationAction.request.url) {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    /// The page's own dictation may use the mic; camera never.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        let allowed = type == .microphone && BridgeGate.accepts(
            isMainFrame: frame.isMainFrame,
            origin: FrameOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
            pageURL: webView.url)
        return allowed ? .grant : .deny
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = String(message.prefix(500))
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = String(message.prefix(500))
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// <input type=file> (importing audio or notes).
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        return panel.runModal() == .OK ? panel.urls : nil
    }

    // MARK: Downloads (notes export)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        try? FileManager.default.removeItem(at: url)   // the user already confirmed "Replace"
        return url
    }
}

/// Avoids a retain cycle (WKUserContentController holds handlers strongly).
@MainActor
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: VaaniWindowController?
    init(owner: VaaniWindowController) { self.owner = owner }
    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { if let owner { owner.receive(message) } }
    }
}
#endif
