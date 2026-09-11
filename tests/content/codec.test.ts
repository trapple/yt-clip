import { describe, expect, test } from "vitest";
import { MP4_MIME, WEBM_MIME, pickMimeType } from "@/content/codec";

describe("pickMimeType", () => {
  test("MP4 が使えるなら MP4 を選ぶ", () => {
    const supportsAll = () => true;
    expect(pickMimeType(supportsAll)).toEqual({
      mimeType: MP4_MIME,
      mp4: true,
    });
  });

  test("MP4 が使えなければ WebM へ退避する", () => {
    const supportsWebmOnly = (type: string) => type === WEBM_MIME;
    expect(pickMimeType(supportsWebmOnly)).toEqual({
      mimeType: WEBM_MIME,
      mp4: false,
    });
  });

  test("どちらも使えなければ握り潰さず throw する", () => {
    const supportsNothing = () => false;
    expect(() => pickMimeType(supportsNothing)).toThrow(
      "この環境では動画を録画できません",
    );
  });

  test("MP4 の判定には H.264 と AAC を明示した MIME を使う", () => {
    expect(MP4_MIME).toBe('video/mp4;codecs="avc1.42E01E,mp4a.40.2"');
  });
});
