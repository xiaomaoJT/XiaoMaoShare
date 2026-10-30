/*
 * 文件类型分类 —— 一处判定，三处使用：
 *   · 主界面 public/index.html 的消息气泡
 *   · 桌面端悬浮球 desktop/ball.html
 *   · 桌面主进程 desktop/main.js（悬浮球列表要算「这是什么类型」的头像）
 *
 * 只回答「这是什么类型、头像上写什么」，不含颜色。
 * 配色放进各自的样式表（[data-k] / .k-doc …），这样主界面能跟着主题走，
 * 悬浮球也能用自己那套白底卡片配色，而「哪些后缀算同一类」只有一份。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.xmFileType = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  var MAP = {
    img: 'png jpg jpeg jpe gif webp bmp avif svg heic heif tif tiff ico psd raw cr2 nef',
    video: 'mp4 mov m4v mkv avi webm flv wmv mpg mpeg m2ts ts 3gp rmvb vob',
    audio: 'mp3 wav flac aac m4a ogg opus wma aiff ape mid midi amr',
    pdf: 'pdf',
    doc: 'doc docx rtf odt pages wps dot dotx md markdown',
    sheet: 'xls xlsx xlsm csv tsv ods numbers et',
    slide: 'ppt pptx pps ppsx key odp dps',
    zip: 'zip rar 7z tar gz tgz bz2 xz zst lz4 iso dmg',
    code: 'js mjs cjs jsx ts tsx json jsonc html htm css scss sass less py java c h cpp cc hpp cs go rs rb php sh bash zsh fish ps1 yml yaml xml sql toml ini cfg conf env vue svelte ipynb patch diff',
    text: 'txt text log nfo me readme',
    app: 'exe msi apk app deb rpm appimage bat cmd jar',
  };

  var EXT2KEY = {};
  Object.keys(MAP).forEach(function (k) {
    MAP[k].split(' ').forEach(function (e) { if (e) EXT2KEY[e] = k; });
  });

  /** 取后缀：没有 / 太怪的一律空串（".bashrc" 这种点开头的没有后缀） */
  function extOf(name) {
    var s = String(name == null ? '' : name).trim();
    var i = s.lastIndexOf('.');
    if (i <= 0 || i === s.length - 1) return '';
    return s.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  }

  /** 类型名：后缀最多 4 个字（png → PNG、markdown → MARK），没后缀就是 FILE */
  function labelOf(ext) {
    return ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
  }

  /**
   * @param {string} name 文件名
   * @param {string} [mime] 只在后缀认不出来时兜底（网页里拖来的文件常常没名字只有 mime）
   * @returns {{key:string, ext:string, label:string}}
   */
  function of(name, mime) {
    var ext = extOf(name);
    var key = EXT2KEY[ext];
    if (!key) {
      var m = String(mime || '').toLowerCase();
      if (/^image\//.test(m)) key = 'img';
      else if (/^video\//.test(m)) key = 'video';
      else if (/^audio\//.test(m)) key = 'audio';
      else if (/pdf/.test(m)) key = 'pdf';
      else if (/zip|compressed|tar/.test(m)) key = 'zip';
      else if (/^text\//.test(m)) key = 'text';
      else key = 'other';
    }
    return { key: key, ext: ext, label: labelOf(ext) };
  }

  return { of: of, extOf: extOf, labelOf: labelOf };
});
