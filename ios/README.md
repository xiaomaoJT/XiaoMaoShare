# iOS 端：当前走 PWA，壳是预留能力

> **当前主线：不用装任何东西。** iPhone 上用 Safari 打开主机地址 → 分享按钮 → 「添加到主屏幕」，
> 得到全屏、有图标、无地址栏的「App」，数据走 localStorage（接入历史可用）。
> 下载文件建议在弹出的 Safari 页面里完成。

下面是**真 App 壳**（WKWebView）的预留能力：想要桌面图标长按不晃、想脱离 Safari 进程、
想以后上架 TestFlight 时，再按本指南做。源码在 `ios/Sources/`，三个文件直接粘进 Xcode 工程。

## 自签侧载是怎么回事

苹果规定：任何装上 iPhone 的 App 都必须**签名**。签名分三档：

| 方式 | 成本 | 限制 |
| --- | --- | --- |
| **免费 Apple ID 自签**（本指南） | 0 元 | 装一次**管 7 天**，到期重新插线签一次；同时最多 3 个自签 App；需要一台 Mac + Xcode |
| 付费开发者账号（99 美元/年） | ¥700/年 | 一次签名管 1 年，可上 TestFlight 分发给别人 |
| 企业签 / 超级签 | 灰色渠道，贵且随时翻车 | 不建议 |

7 天到期后的表现：App 图标还在，点开闪退。重新用 Xcode 往手机上跑一遍即可续期，数据不丢。

## 手把手操作（约 15 分钟，一次性）

1. **装 Xcode**：Mac 上 App Store 搜 Xcode 安装（约 10GB，需要较新的 macOS）。
2. **建工程**：Xcode → File → New → Project → iOS → **App**：
   - Product Name：`XiaoMaoShare`
   - Organization Identifier：`com.xiaomao`（随便，保证全局唯一即可）
   - Interface：**SwiftUI**；Language：**Swift**
3. **贴源码**：建好后工程里自动有 `XiaoMaoShareApp.swift` 和 `ContentView.swift` 两个文件——
   把它们的内容**整个替换**为本仓库 `ios/Sources/` 下同名文件；再把 `ios/Sources/WebView.swift`
   拖进工程（弹窗勾选 "Copy items if needed" + 勾选 target）。
4. **签名**：左侧点蓝色工程图标 → TARGETS → Signing & Capabilities：
   - 勾选 "Automatically manage signing"
   - Team：选你登录的 Apple ID（没有就 Xcode → Settings → Accounts 用普通 Apple ID 登录，免费）
   - Bundle Identifier：改成 `com.xiaomao.share2026`（提示被占用就随便加点数字）
5. **信任开发者**（首次装时手机上操作）：iPhone 数据线连 Mac，Xcode 顶部设备选你的 iPhone →
   点 ▶ Run。第一次会失败，提示"不受信任的开发者"——去手机 **设置 → 通用 → VPN与设备管理**
   → 找到你的 Apple ID → 点「信任」。
6. **图标**：Xcode 工程里 Assets → AppIcon，把 `public/icon.png` 的 1024 版拖进
   "iOS App Icon" 单格即可（Xcode 14+ 自动切全部尺寸）。
7. 以后每 **7 天**：插线，Xcode 里再点一次 ▶ Run 就续上了。

## 常见坑

- **免费账号每周 App ID 配额**：一个 Apple ID 每周最多建 10 个新 App ID，正常够用。
- **升级 iOS 后签名失效**：重新插线 Run 一次。
- **想给别人装**：免费自签不行（必须用对方自己的 Mac + Apple ID 签）。要分发就得上付费账号
  的 TestFlight，或让对方的 iPhone 直接用 PWA（这也是我们把 PWA 当主线的原因）。
