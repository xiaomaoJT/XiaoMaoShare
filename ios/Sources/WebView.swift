import SwiftUI
import WebKit

/// WKWebView 包装：加载主机地址；reloadToken 变化时刷新
struct WebView: UIViewRepresentable {
    let urlString: String
    @Binding var reloadToken: Int

    func makeCoordinator() -> Coord { Coord() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.allowsBackForwardNavigationGestures = true
        if let u = Self.toURL(urlString) {
            w.load(URLRequest(url: u))
        }
        return w
    }

    func updateUIView(_ w: WKWebView, context: Context) {
        if context.coordinator.lastReload != reloadToken {
            context.coordinator.lastReload = reloadToken
            w.reload()
        }
    }

    final class Coord {
        var lastReload = 0
    }

    /// 归一化：补端口 6767、补 http://
    static func toURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.lowercased().hasPrefix("http://") { s = String(s.dropFirst(7)) }
        else if s.lowercased().hasPrefix("https://") { s = String(s.dropFirst(8)) }
        while s.hasSuffix("/") { s.removeLast() }
        if !s.contains(":") { s += ":6767" }
        return URL(string: "http://" + s)
    }
}
