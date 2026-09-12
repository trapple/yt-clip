import { describe, expect, test } from "vitest";
import {
  DisplayMatrixError,
  fixVideoDisplayMatrix,
} from "@/content/display-matrix";
import { buildFragmentedMp4, type FakeSample } from "../helpers/fragmented-mp4";

const FIXED_POINT_ONE = 0x40000000;

function sample(): FakeSample {
  return { data: new Uint8Array([1, 2, 3]), duration: 100, sync: true };
}

/** 最初の tkhd の行列の最後の要素を読む */
function readMatrixW(data: Uint8Array): number {
  const at = data.indexOf(0x74); // 't' から tkhd を探す
  let index = at;
  while (index + 4 < data.length) {
    if (
      data[index] === 0x74 &&
      data[index + 1] === 0x6b &&
      data[index + 2] === 0x68 &&
      data[index + 3] === 0x64
    ) {
      const body = index + 4;
      const version = data[body];
      const matrixAt = body + (version === 1 ? 4 + 32 + 16 : 4 + 20 + 16);
      return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
        matrixAt + 32,
      );
    }
    index += 1;
  }
  throw new Error("tkhd が見つかりません");
}

describe("fixVideoDisplayMatrix", () => {
  test("映像トラックの壊れた行列を直す", () => {
    // captureStream 由来のフレームでは Chromium の muxer が最後の要素を
    // 書き忘れる。0 のままだと表示サイズの計算が 0 除算になり、X の変換が落ちる
    const input = buildFragmentedMp4({ fragments: [[sample()]] });
    expect(readMatrixW(input)).toBe(0);

    expect(readMatrixW(fixVideoDisplayMatrix(input))).toBe(FIXED_POINT_ONE);
  });

  test("長さを変えない", () => {
    // 長さが変わると stco などが指す位置がずれて壊れる
    const input = buildFragmentedMp4({ fragments: [[sample()], [sample()]] });
    expect(fixVideoDisplayMatrix(input).length).toBe(input.length);
  });

  test("直すのは 4 バイトだけ", () => {
    const input = buildFragmentedMp4({ fragments: [[sample()]] });
    const out = fixVideoDisplayMatrix(input);

    let changed = 0;
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] !== input[i]) changed += 1;
    }
    // 0x00000000 → 0x40000000 なので、実際に変わるのは 1 バイト
    expect(changed).toBe(1);
  });

  test("既に正しい行列なら入力をそのまま返す", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample()]],
      brokenMatrix: false,
    });
    expect(fixVideoDisplayMatrix(input)).toBe(input);
  });

  test("音声だけのトラックには触らない", () => {
    // 実機では音声トラックの行列が全ゼロのままでも X に通っている
    const input = buildFragmentedMp4({
      fragments: [[sample()]],
      width: 0,
      height: 0,
    });
    expect(fixVideoDisplayMatrix(input)).toBe(input);
  });

  test("MP4 でないデータは握り潰さず throw する", () => {
    expect(() => fixVideoDisplayMatrix(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      DisplayMatrixError,
    );
  });
});
