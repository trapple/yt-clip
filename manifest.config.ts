import { defineManifest } from "@crxjs/vite-plugin";

/**
 * 権限は設計ドキュメント「必要な権限」表と 1:1 対応させる。
 *
 * **権限を足したら `docs/store-release.md` の説明文も直すこと。**
 * ウェブストアは権限ごとに用途の説明を求め、実装と食い違うと審査で止まる。
 */
export default defineManifest({
  manifest_version: 3,
  name: "yt-clip",
  version: "0.1.0",
  description: "YouTube の切り抜きを作って X に投稿する",
  homepage_url: "https://github.com/trapple/yt-clip",
  // ダウンロードは content script がアンカー要素で行うため権限は要らない。
  //
  // **`tabs` は要らない。** tabs.sendMessage はホスト権限で足り、
  // tabs.create と tabs.onRemoved は無権限で動く (tab.url や tab.title を
  // 読んで初めて必要になる)。審査でもっとも突っ込まれる権限なので持たない
  permissions: ["storage"],
  host_permissions: ["https://www.youtube.com/*", "https://x.com/*"],
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  background: {
    service_worker: "src/background/sw.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/popup.html",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
  content_scripts: [
    {
      matches: ["https://www.youtube.com/watch*"],
      js: ["src/content/youtube.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://x.com/*"],
      js: ["src/content/x.ts"],
      run_at: "document_idle",
    },
  ],
});
