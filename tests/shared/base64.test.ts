import { describe, expect, test } from "vitest";
import { decodeBase64, encodeBase64 } from "@/shared/base64";

/** 中身が偏らないよう、位置ごとに違う値を並べる */
function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 7 + 13) % 256;
  }
  return bytes;
}

describe("base64 の往復", () => {
  test("空のデータを扱える", () => {
    expect(decodeBase64(encodeBase64(new Uint8Array(0)))).toEqual(
      new Uint8Array(0),
    );
  });

  test("0 から 255 までのすべてのバイト値が保たれる", () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) bytes[index] = index;

    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  test("分割の境界をまたいでも壊れない", () => {
    // 0x8000 ごとに分割している。境界の前後と、3 の倍数でない長さを試す。
    // チャンクごとに btoa を呼ぶ実装だと、ここでパディングが混入して壊れる
    for (const length of [0x7fff, 0x8000, 0x8001, 0x8000 * 2 + 1]) {
      const bytes = makeBytes(length);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  test("大きなデータでも呼び出しが失敗しない", () => {
    // String.fromCharCode に一度に渡しすぎると落ちる。分割の目的がこれ
    const bytes = makeBytes(0x8000 * 5);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
