import { describe, expect, test } from "vitest";
import {
  indexAt,
  isOverLimit,
  normalize,
  toSourceTime,
  totalSec,
} from "@/shared/timeline";
import type { ClipRange } from "@/shared/types";

const seg = (startSec: number, endSec: number): ClipRange => ({
  startSec,
  endSec,
});

describe("normalize", () => {
  test("空配列はそのまま", () => {
    expect(normalize([])).toEqual([]);
  });

  test("動画の時間順に並べ替える", () => {
    expect(normalize([seg(242, 250), seg(83, 98)])).toEqual([
      seg(83, 98),
      seg(242, 250),
    ]);
  });

  test("重なった区間は 1 つに繋ぐ", () => {
    expect(normalize([seg(83, 98), seg(90, 105)])).toEqual([seg(83, 105)]);
  });

  test("隣接した区間も繋ぐ。間に切れ目はない", () => {
    expect(normalize([seg(83, 98), seg(98, 105)])).toEqual([seg(83, 105)]);
  });

  test("内側に完全に含まれる区間を飲み込む", () => {
    expect(normalize([seg(83, 120), seg(90, 105)])).toEqual([seg(83, 120)]);
  });

  test("3 つ以上が数珠つなぎでも 1 つになる", () => {
    expect(normalize([seg(10, 20), seg(18, 30), seg(25, 40)])).toEqual([
      seg(10, 40),
    ]);
  });

  test("離れた区間は繋がない", () => {
    expect(normalize([seg(10, 20), seg(30, 40)])).toEqual([
      seg(10, 20),
      seg(30, 40),
    ]);
  });

  test("元の配列を壊さない", () => {
    const input = [seg(30, 40), seg(10, 20)];
    normalize(input);
    expect(input).toEqual([seg(30, 40), seg(10, 20)]);
  });

  test("不正な区間は握り潰さず throw する", () => {
    // UI のバグ。黙って直すと、録画に実時間を払った後で気付くことになる
    expect(() => normalize([seg(-1, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(10, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(20, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(Number.NaN, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(0, Number.POSITIVE_INFINITY)])).toThrow(
      RangeError,
    );
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

describe("indexAt", () => {
  const segments = [seg(10, 20), seg(30, 40)];

  test("その秒を含む区間を返す", () => {
    expect(indexAt(segments, 15)).toBe(0);
    expect(indexAt(segments, 35)).toBe(1);
  });

  test("境界は含む", () => {
    expect(indexAt(segments, 10)).toBe(0);
    expect(indexAt(segments, 20)).toBe(0);
  });

  test("どの区間にも入らなければ -1", () => {
    expect(indexAt(segments, 25)).toBe(-1);
    expect(indexAt(segments, 0)).toBe(-1);
  });

  test("空配列なら -1", () => {
    expect(indexAt([], 15)).toBe(-1);
  });
});

describe("toSourceTime", () => {
  // 出力 0〜15 秒が 83〜98、15〜23 秒が 242〜250 に対応する
  const segments = [seg(83, 98), seg(242, 250)];

  test("最初の区間の中", () => {
    expect(toSourceTime(segments, 0)).toBe(83);
    expect(toSourceTime(segments, 5)).toBe(88);
  });

  test("区間をまたぐ", () => {
    expect(toSourceTime(segments, 15)).toBe(242);
    expect(toSourceTime(segments, 20)).toBe(247);
  });

  test("出力の長さを超えたら null", () => {
    expect(toSourceTime(segments, 23)).toBeNull();
    expect(toSourceTime(segments, 100)).toBeNull();
  });

  test("負の秒は null", () => {
    expect(toSourceTime(segments, -1)).toBeNull();
  });

  test("空配列なら null", () => {
    expect(toSourceTime([], 0)).toBeNull();
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
