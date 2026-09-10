import { defineManifest } from "@crxjs/vite-plugin";

// 権限は設計ドキュメント「必要な権限」表と 1:1 対応させる
export default defineManifest({
  manifest_version: 3,
  name: "yt-clip",
  version: "0.1.0",
  description: "YouTube の切り抜きを作って X に投稿する",
  permissions: ["tabCapture", "offscreen", "storage", "tabs", "downloads"],
  host_permissions: ["https://www.youtube.com/*", "https://x.com/*"],
  background: {
    service_worker: "src/background/sw.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/popup.html",
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
