import { tagsVariable } from "@/shared/settings";
import { formatTime, toUrlSeconds } from "@/shared/time";
import type { ClipRange, VideoMeta } from "@/shared/types";

// 既定のテンプレートは設定の一部なので settings.ts が持つ
export { DEFAULT_TEMPLATE } from "@/shared/settings";

/** 切り抜き開始位置つきの短縮 URL を組み立てる */
export function buildYouTubeUrl(videoId: string, startSec: number): string {
  return `https://youtu.be/${videoId}?t=${toUrlSeconds(startSec)}`;
}

/** テンプレート変数を展開する。未知の変数はバグなので throw する */
export function renderTemplate(
  template: string,
  meta: VideoMeta,
  range: ClipRange,
  hashtags: string[] = [],
): string {
  const vars: Record<string, string> = {
    title: meta.title,
    videoId: meta.videoId,
    url: buildYouTubeUrl(meta.videoId, range.startSec),
    start: formatTime(range.startSec),
    end: formatTime(range.endSec),
    duration: String(Math.round(range.endSec - range.startSec)),
    // **自分で区切りを持つ。** テンプレート側に改行を書くと、タグが
    // 未設定のときに本文が空行 2 つで終わる
    tags: tagsVariable(hashtags),
  };

  return template.replace(/\{(\w+)\}/g, (matched, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`テンプレートに未知の変数があります: ${matched}`);
    }
    return value;
  });
}
