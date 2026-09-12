/**
 * 録画した動画をブラウザのダウンロード先へ保存する。
 *
 * **service worker では保存できない。** MV3 の service worker は
 * `URL.createObjectURL` を持たず、Blob を指す URL を作れない。DOM のある
 * content script でアンカー要素を組み立てて保存する。
 *
 * 置き場所はブラウザの設定に従う (指定していなければ `~/Downloads`)。
 * **拡張から任意の絶対パスは指定できない。** `~/Downloads/yt-clip/` のような
 * サブフォルダを作るには offscreen document が要るため、平置きにしている。
 */

export type SaveDeps = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): HTMLAnchorElement;
};

const defaultDeps: SaveDeps = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => {
    URL.revokeObjectURL(url);
  },
  createAnchor: () => document.createElement("a"),
};

export function saveToDownloads(
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  mimeType: string,
  deps: SaveDeps = defaultDeps,
): void {
  let url: string | null = null;
  try {
    url = deps.createObjectURL(new Blob([bytes], { type: mimeType }));
    const anchor = deps.createAnchor();
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    anchor.click();
    anchor.remove();
  } catch (error) {
    // **録画は捨てない。** 実時間のコストを払い終えており、保存は後処理に
    // 過ぎない。ここで投げると録画ごと失われるので、理由だけ残して続ける
    console.warn(`[yt-clip] 録画を保存できませんでした: ${String(error)}`);
  } finally {
    // 解放しないと、録るたびにメモリを掴んだままになる
    if (url !== null) deps.revokeObjectURL(url);
  }
}
