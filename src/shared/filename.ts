/**
 * 添付・ダウンロードに使うファイル名を組み立てる。
 * service worker からも使うため DOM 依存を持たせない。
 */
export function buildClipFileName(
  videoId: string,
  startSec: number,
  mimeType: string,
): string {
  const extension = mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("webm")
      ? "webm"
      : null;
  if (extension === null) {
    throw new Error(`未知の動画形式です: ${mimeType}`);
  }
  return `yt-clip-${videoId}-${Math.floor(startSec)}s.${extension}`;
}
