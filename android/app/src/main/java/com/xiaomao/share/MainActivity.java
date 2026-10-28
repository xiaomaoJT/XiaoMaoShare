package com.xiaomao.share;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * XiaoMaoShare Android WebView 薄壳。
 * 零第三方依赖：只用 Android SDK 自带类。
 * 首次启动输入主机地址（预填 192.168.、端口不填默认 6767），
 * 之后直接进 WebView；顶部小工具条可改地址 / 刷新 / 用浏览器打开。
 */
public class MainActivity extends Activity {

    private static final String PREF = "xm";
    private static final String KEY_ADDR = "addr";
    private static final int REQ_FILE = 1001;

    private WebView web;
    private LinearLayout setup;
    private FrameLayout root;
    private LinearLayout toolbar;
    private EditText addrInput;
    private ValueCallback<Uri[]> fileCb;
    private String pendingUrl; // 加载失败时的重试目标

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        String saved = prefs().getString(KEY_ADDR, null);
        if (saved != null && !saved.isEmpty()) {
            enterWeb(saved);
        } else {
            showSetup();
        }
    }

    /* ------------------------------------------------------------ UI 构建 */

    private void buildUi() {
        root = new FrameLayout(this);

        // ---- 首次接入屏 ----
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setGravity(Gravity.CENTER);
        setup.setPadding(dp(32), dp(24), dp(32), dp(24));

        TextView title = new TextView(this);
        title.setText("连接到 XiaoMaoShare 主机");
        title.setTextSize(19);
        title.setTextColor(Color.parseColor("#18191C"));
        title.setGravity(Gravity.CENTER);
        setup.addView(title);

        TextView tip = new TextView(this);
        tip.setText("输入主机的局域网地址，端口不填默认 6767");
        tip.setTextSize(13);
        tip.setTextColor(Color.parseColor("#8A8F99"));
        tip.setGravity(Gravity.CENTER);
        tip.setPadding(0, dp(6), 0, dp(20));
        setup.addView(tip);

        addrInput = new EditText(this);
        addrInput.setText("192.168.");
        addrInput.setSelection(addrInput.getText().length());
        addrInput.setSingleLine(true);
        addrInput.setHint("如 1.20（完整示例 192.168.1.20:6767）");
        addrInput.setTextSize(16);
        setup.addView(addrInput);

        Button go = new Button(this);
        go.setText("连接");
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { connect(); }
        });
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gp.topMargin = dp(16);
        go.setLayoutParams(gp);
        setup.addView(go);

        // ---- WebView + 工具条 ----
        LinearLayout webWrap = new LinearLayout(this);
        webWrap.setOrientation(LinearLayout.VERTICAL);

        toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setBackgroundColor(Color.parseColor("#F3F4F6"));
        toolbar.setPadding(dp(8), dp(2), dp(8), dp(2));
        toolbar.addView(barBtn("改地址", new View.OnClickListener() {
            @Override public void onClick(View v) {
                String cur = prefs().getString(KEY_ADDR, "192.168.");
                addrInput.setText(cur);
                addrInput.setSelection(cur.length());
                showSetup();
            }
        }));
        toolbar.addView(barBtn("刷新", new View.OnClickListener() {
            @Override public void onClick(View v) { if (web != null) web.reload(); }
        }));
        toolbar.addView(barBtn("浏览器打开", new View.OnClickListener() {
            @Override public void onClick(View v) {
                String a = prefs().getString(KEY_ADDR, null);
                if (a != null) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("http://" + a)));
            }
        }));
        webWrap.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(36)));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage：接入历史要用
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        web.setWebViewClient(new ViewClient());
        web.setWebChromeClient(new ChromeClient());
        web.setDownloadListener(new DownloadLst());
        webWrap.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webWrap.setVisibility(View.GONE);

        root.addView(webWrap, new FrameLayout.LayoutParams(-1, -1));
        root.addView(setup, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
    }

    private TextView barBtn(String label, View.OnClickListener l) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(13);
        t.setTextColor(Color.parseColor("#4F7CFF"));
        t.setPadding(dp(10), dp(8), dp(10), dp(8));
        t.setOnClickListener(l);
        return t;
    }

    /* ------------------------------------------------------------ 接入逻辑 */

    /** 归一化地址：trim；无端口补 :6767；返回 host:port（不带 scheme） */
    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (s.toLowerCase().startsWith("http://")) s = s.substring(7);
        else if (s.toLowerCase().startsWith("https://")) s = s.substring(8);
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.contains(":")) s += ":6767";
        return s;
    }

    private void connect() {
        String a = normalize(addrInput.getText().toString());
        if (a == null) { toast("先填主机的地址"); return; }
        prefs().edit().putString(KEY_ADDR, a).apply();
        enterWeb(a);
    }

    private void enterWeb(String addr) {
        setup.setVisibility(View.GONE);
        ((ViewGroup) toolbar.getParent()).setVisibility(View.VISIBLE);
        pendingUrl = "http://" + addr;
        web.loadUrl(pendingUrl);
    }

    private void showSetup() {
        ((ViewGroup) toolbar.getParent()).setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREF, MODE_PRIVATE);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    /* ------------------------------------------------------------ WebView 回调 */

    private class ViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String sc = u.getScheme() == null ? "" : u.getScheme();
            // http/https 留在壳内（连别的主机是本 App 的功能）；其他交给系统
            if (sc.equals("http") || sc.equals("https")) return false;
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) {
                String html = "<html><head><meta charset='utf-8'>"
                        + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<style>body{font-family:sans-serif;text-align:center;padding-top:80px;color:#8A8F99}"
                        + "a{color:#4F7CFF}</style></head><body>"
                        + "<p>连不上主机 :(</p>"
                        + "<p style='font-size:13px'>检查两台设备在同一 Wi-Fi、主机已启动、地址端口没错</p>"
                        + "<p><a href='" + pendingUrl + "'>点此重试</a></p>"
                        + "</body></html>";
                view.loadData(html, "text/html; charset=utf-8", null);
            }
        }
    }

    private class ChromeClient extends WebChromeClient {
        /** 文件上传（<input type=file>）——互传 App 的关键能力 */
        @Override
        public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileCb != null) fileCb.onReceiveValue(null);
            fileCb = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
            } catch (Exception e) {
                fileCb = null;
                toast("打不开文件选择器");
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCb = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    /** 下载走系统 DownloadManager，完成后通知栏可见 */
    private class DownloadLst implements android.webkit.DownloadListener {
        @Override
        public void onDownloadStart(String url, String ua, String disp, String mime, long size) {
            try {
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                String ck = CookieManager.getInstance().getCookie(url);
                if (ck != null) r.addRequestHeader("Cookie", ck);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, disp, mime));
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(r);
                toast("已开始下载");
            } catch (Exception e) {
                toast("下载失败：" + e.getMessage());
            }
        }
    }

    /* ------------------------------------------------------------ 生命周期 */

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onRestoreInstanceState(Bundle savedInstanceState) {
        super.onRestoreInstanceState(savedInstanceState);
        if (web != null && savedInstanceState != null) {
            web.restoreState(savedInstanceState);
            setup.setVisibility(View.GONE);
            ((ViewGroup) toolbar.getParent()).setVisibility(View.VISIBLE);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
