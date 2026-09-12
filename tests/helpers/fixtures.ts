import type { Channel } from "@/shared/settings";
import type { VideoMeta } from "@/shared/types";

/**
 * テストで使うチャンネル。
 *
 * **鍵はハンドル。** 実機の watch ページには `UC...` が出ておらず、
 * `getChannel` もハンドルを優先する。テストの値がそれとずれていると、
 * 読み手に「鍵は UC...」という誤った印象を与える
 */
export const CHANNEL: Channel = { id: "@channel-a", name: "チャンネル A" };

/**
 * 動画のメタ情報。**差分だけを渡すこと。**
 *
 * `VideoMeta` に項目を足すたびにテストを 6 ファイル書き換えていたので、
 * 既定値をここ 1 つに寄せた
 */
export function makeVideoMeta(overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    videoId: "abc123",
    title: "テスト動画",
    channelId: CHANNEL.id,
    ...overrides,
  };
}
