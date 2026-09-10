import { formatTime, toUrlSeconds } from "@/shared/time";
import type { ClipRange, VideoMeta } from "@/shared/types";

/** 既定の投稿本文。タイトルと元動画 URL を空行で挟む */
export const DEFAULT_TEMPLATE = "{title}\n\n{url}";

/** 切り抜き開始位置つきの短縮 URL を組み立てる */
export function buildYouTubeUrl(videoId: string, startSec: number): string {
  return `https://youtu.be/${videoId}?t=${toUrlSeconds(startSec)}`;
}

/** テンプレート変数を展開する。未知の変数はバグなので throw する */
export function renderTemplate(
  template: string,
  meta: VideoMeta,
  range: ClipRange,
): string {
  const vars: Record<string, string> = {
    title: meta.title,
    videoId: meta.videoId,
    url: buildYouTubeUrl(meta.videoId, range.startSec),
    start: formatTime(range.startSec),
    end: formatTime(range.endSec),
    duration: String(Math.round(range.endSec - range.startSec)),
  };

  return template.replace(/\{(\w+)\}/g, (matched, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`テンプレートに未知の変数があります: ${matched}`);
    }
    return value;
  });
}
