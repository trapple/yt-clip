import { describe, expect, test } from "vitest";
import { findMatches, normalizeForSearch, normalizeQuery } from "@/content/transcript-search";

const find = (source: string, query: string) => findMatches(normalizeForSearch(source), normalizeQuery(query));

describe("normalizeForSearch", () => {
  test("NFKC で揃え、英字を小文字にする", () => {
    expect(normalizeForSearch("ＡＢＣ１２３").text).toBe("abc123");
  });

  test("半角のカナと濁点は 1 文字にまとめる (2 文字から来た 1 文字は元の 2 文字を指す)", () => {
    const normalized = normalizeForSearch("ｶﾞｲﾄﾞ");
    expect(normalized.text).toBe("ガイド");
    expect(normalized.starts).toEqual([0, 2, 3]);
    expect(normalized.ends).toEqual([2, 3, 5]);
  });

  test("ひらがなとカタカナは揃えない", () => {
    expect(normalizeForSearch("みぎ").text).not.toBe(normalizeForSearch("ミギ").text);
  });
});

describe("normalizeQuery", () => {
  test("前後の空白を落とし、本文と同じに揃える", () => {
    expect(normalizeQuery("  ＲＩＧＨＴ ")).toBe("right");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("findMatches", () => {
  test("元の文字の位置で返す", () => {
    expect(find("ここは絶対に右から回る", "右から")).toEqual([{ start: 6, end: 9 }]);
  });

  test("全角で打っても半角に当たり、大小を区別しない", () => {
    expect(find("Game Over", "ｇａｍｅ")).toEqual([{ start: 0, end: 4 }]);
  });

  test("半角のカナに全角で当たると、濁点まで含めた範囲を返す", () => {
    expect(find("ｶﾞｲﾄﾞです", "ガイド")).toEqual([{ start: 0, end: 5 }]);
  });

  test("サロゲートペアを割らない", () => {
    expect(find("𠮷野家", "野")).toEqual([{ start: 2, end: 3 }]);
    expect(find("𠮷野家", "𠮷")).toEqual([{ start: 0, end: 2 }]);
  });

  test("重ならずに全部返す", () => {
    expect(find("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  test("空の query と当たらない query は []", () => {
    expect(find("abc", "")).toEqual([]);
    expect(find("abc", "x")).toEqual([]);
  });
});

describe("本文と検索の文字を同じ規則で揃える (whole-branch review)", () => {
  test("語末の Σ も、本文と同じに打てば当たる (文字列ごとの小文字化は語末を ς にする)", () => {
    expect(find("ΟΔΟΣ", "ΟΔΟΣ")).toEqual([{ start: 0, end: 4 }]);
  });

  test("分解したハングルの字母は、合成済みの文字に当たる", () => {
    expect(find("\u1100\u1161", "\uAC00")).toEqual([{ start: 0, end: 2 }]);
  });

  test("肌の色の付いた絵文字は途中で割らない", () => {
    expect(find("👍🏽いいね", "👍")).toEqual([{ start: 0, end: 4 }]);
  });
});
