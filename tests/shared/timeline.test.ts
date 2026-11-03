import { describe, expect, test } from "vitest";
import {
  assertValidSegments,
  isOverLimit,
  totalSec,
} from "@/shared/timeline";
import type { ClipRange } from "@/shared/types";

const seg = (startSec: number, endSec: number): ClipRange => ({
  startSec,
  endSec,
});

describe("assertValidSegments", () => {
  test("拾った順のまま扱う。並べ替えもマージもしない", () => {
    // 検証するだけで何も返さない。並びを変えると、区間の中で「追加」を
    // 押したときに無反応になり、同じ場面を 2 回使うこともできなくなる
    expect(() =>
      assertValidSegments([seg(242, 250), seg(83, 98)]),
    ).not.toThrow();
  });

  test("重なる区間を許す", () => {
    expect(() => assertValidSegments([seg(83, 120), seg(90, 105)])).not.toThrow();
  });

  test("空配列を許す", () => {
    expect(() => assertValidSegments([])).not.toThrow();
  });

  test("不正な区間は握り潰さず throw する", () => {
    // UI のバグ。黙って直すと、録画に実時間を払った後で気付くことになる
    expect(() => assertValidSegments([seg(-1, 10)])).toThrow(RangeError);
    expect(() => assertValidSegments([seg(10, 10)])).toThrow(RangeError);
    expect(() => assertValidSegments([seg(20, 10)])).toThrow(RangeError);
    expect(() => assertValidSegments([seg(Number.NaN, 10)])).toThrow(RangeError);
    expect(() =>
      assertValidSegments([seg(0, Number.POSITIVE_INFINITY)]),
    ).toThrow(RangeError);
  });
});

describe("totalSec", () => {
  test("区間の長さを足す", () => {
    expect(totalSec([seg(83, 98), seg(242, 250)])).toBe(23);
  });

  test("空なら 0", () => {
    expect(totalSec([])).toBe(0);
  });
});

describe("isOverLimit", () => {
  test("合計が上限以内なら通す", () => {
    expect(isOverLimit([seg(0, 30), seg(100, 130)], 60)).toBe(false);
  });

  test("合計が上限を超えたら弾く", () => {
    expect(isOverLimit([seg(0, 30), seg(100, 131)], 60)).toBe(true);
  });

  test("丸めてから比べる", () => {
    // 表示は「合計 60秒 / 60秒」になる。ここで弾くと、押せない理由が
    // 画面のどこにも出ない状態ができる
    expect(isOverLimit([seg(0, 60.4)], 60)).toBe(false);
    expect(isOverLimit([seg(0, 60.5)], 60)).toBe(true);
  });
});
