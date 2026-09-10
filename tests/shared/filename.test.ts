import { describe, expect, test } from "vitest";
import { buildClipFileName } from "@/shared/filename";

describe("buildClipFileName", () => {
  test("MP4 には mp4 拡張子を付ける", () => {
    expect(
      buildClipFileName("dQw4w9WgXcQ", 75.4, 'video/mp4;codecs="avc1"'),
    ).toBe("yt-clip-dQw4w9WgXcQ-75s.mp4");
  });

  test("WebM には webm 拡張子を付ける", () => {
    expect(buildClipFileName("abc", 0, "video/webm;codecs=vp9,opus")).toBe(
      "yt-clip-abc-0s.webm",
    );
  });

  test("未知の形式は throw する", () => {
    expect(() => buildClipFileName("abc", 0, "video/ogg")).toThrow(
      "未知の動画形式です: video/ogg",
    );
  });
});
