import { describe, expect, test } from "vitest";
import {
  MP4_MIME,
  WEBM_MIME,
  baseMimeType,
  pickMimeType,
} from "@/content/codec";

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

describe("baseMimeType", () => {
  test("コーデック指定を落として型だけにする", () => {
    // File.type はパラメータを保持するため、これを落とさないと X の
    // 対応形式の判定に落ちる。中身が正しい MP4 でも弾かれる
    expect(baseMimeType(MP4_MIME)).toBe("video/mp4");
  });

  test("WebM でも同じ規則で落とす", () => {
    expect(baseMimeType(WEBM_MIME)).toBe("video/webm");
  });

  test("パラメータが無ければそのまま返す", () => {
    expect(baseMimeType("video/mp4")).toBe("video/mp4");
  });

  test("前後の空白を落とす", () => {
    expect(baseMimeType(" video/mp4 ; codecs=avc1 ")).toBe("video/mp4");
  });

  test("落とした後も退避判定と拡張子判定は変わらない", () => {
    // storeRecording の `includes("mp4")` と、ファイル名の `includes("webm")`
    // がパラメータを落としても成り立つことを固める
    expect(baseMimeType(MP4_MIME).includes("mp4")).toBe(true);
    expect(baseMimeType(WEBM_MIME).includes("mp4")).toBe(false);
    expect(baseMimeType(WEBM_MIME).includes("webm")).toBe(true);
  });
});
