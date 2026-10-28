import SwiftUI

/// XiaoMaoShare iOS 壳（预留能力，当前主线走 PWA「添加到主屏幕」）。
/// 首次启动输入主机地址（预填 192.168.、端口默认 6767），工具栏可改地址 / 刷新 / Safari 打开。
/// 文件上传：<input type=file> 在 iOS 14.3+ 的 WKWebView 原生可用，无需额外代码。
struct ContentView: View {
    @AppStorage("xm.addr") private var saved: String = ""
    @State private var editing = false
    @State private var draft = "192.168."
    @State private var reloadToken = 0
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Group {
                if saved.isEmpty {
                    setupView
                } else {
                    WebView(urlString: saved, reloadToken: $reloadToken)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !saved.isEmpty {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("改地址") { draft = saved; editing = true }
                    }
                    ToolbarItemGroup(placement: .navigationBarTrailing) {
                        Button("刷新") { reloadToken += 1 }
                        Button("Safari") {
                            if let u = WebView.toURL(saved) { openURL(u) }
                        }
                    }
                }
            }
            .alert("连接到主机", isPresented: $editing) {
                TextField("192.168.", text: $draft)
                Button("连接") {
                    if let u = WebView.toURL(draft),
                       let hp = u.absoluteString.replacingOccurrences(of: "http://", with: "") as String?,
                       !hp.isEmpty {
                        saved = hp
                    }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("输入主机的 IP 和端口，端口不填默认 6767")
            }
        }
    }

    private var setupView: some View {
        VStack(spacing: 14) {
            Text("连接到 XiaoMaoShare 主机")
                .font(.title3.bold())
            Text("输入主机的局域网地址，端口不填默认 6767")
                .font(.footnote)
                .foregroundStyle(.secondary)
            TextField("如 1.20（完整示例 192.168.1.20:6767）", text: $draft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            Button {
                if let u = WebView.toURL(draft) {
                    saved = u.absoluteString.replacingOccurrences(of: "http://", with: "")
                }
            } label: {
                Text("连接").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(28)
    }
}
