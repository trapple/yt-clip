import { defineManifest } from "@crxjs/vite-plugin";
import { readFileSync } from "node:fs";

/**
 * 版番号は `package.json` から読む。**ここに直接書かないこと。**
 *
 * 2 箇所に手書きすると、片方を上げたときにもう片方が置いていかれる。
 * `npm version` は `package.json` だけを更新してタグを打つので、
 * 出どころをそちらに寄せておけば「この版はどのコミットか」が常に辿れる。
 */
function packageVersion(): string {
  const path = new URL("./package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).version
      : undefined;

  if (typeof version !== "string") {
    throw new Error("package.json に version がありません");
  }
  // Chrome が受け付けるのは 1〜4 個の整数をドットで繋いだ形だけ。
  // npm の `1.0.0-beta.1` のような前置き付きは読み込み時に弾かれる。
  // ビルドが通った後に拡張が入らない、という分かりにくい失敗を避けるため
  // ここで止める (前置きを使いたい場合は manifest の version_name が要る)
  if (!/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error(
      `Chrome が受け付けない版番号です: ${version} (整数をドットで繋いだ形のみ)`,
    );
  }
  return version;
}


/**
 * 権限は設計ドキュメント「必要な権限」表と 1:1 対応させる。
 *
 * **権限を足したら `docs/store-release.md` の説明文も直すこと。**
 * ウェブストアは権限ごとに用途の説明を求め、実装と食い違うと審査で止まる。
 */
export default defineManifest({
  manifest_version: 3,
  name: "yt-clip",
  version: packageVersion(),
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
      // **動画ページ (/watch) だけに絞らない。** YouTube の中の移動は SPA なので、ホーム・検索結果・チャンネルから
      // 動画へ移ってもドキュメントの読み込みが起きず、/watch* だけだと content script が入らない。
      // 動画ページ以外ではページに何も差さない (youtube.ts の leaveVideoPage)。host_permissions と同じ範囲なので権限は増えない
      matches: ["https://www.youtube.com/*"],
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
