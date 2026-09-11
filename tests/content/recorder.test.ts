// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { DrmProtectedError, assertRecordable } from "@/content/recorder";

/** mediaKeys は読み取り専用なので、テストからは定義し直して差し替える */
function makeVideo(mediaKeys: unknown): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "mediaKeys", {
    value: mediaKeys,
    configurable: true,
  });
  return video;
}

describe("assertRecordable", () => {
  test("保護されていない動画は通す", () => {
    expect(() => assertRecordable(makeVideo(null))).not.toThrow();
  });

  test("暗号化されている動画は録画前に弾く", () => {
    // captureStream は黒画面を返すだけで失敗しないため、
    // ここで止めないと実時間を払った後で無駄と分かることになる
    expect(() => assertRecordable(makeVideo({}))).toThrow(DrmProtectedError);
  });

  test("失敗の理由が分かるメッセージを持つ", () => {
    expect(() => assertRecordable(makeVideo({}))).toThrow(
      "この動画は保護されているため録画できません",
    );
  });
});
