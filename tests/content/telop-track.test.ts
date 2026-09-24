// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  MAX_TELOP_LANES,
  assignLanes,
  dragTelop,
  grabKindAt,
  telopsInWindow,
} from "@/content/telop-track";

const span = (startSec: number, endSec: number) => ({ startSec, endSec });

describe("telopsInWindow", () => {
  const WINDOW = span(20, 50);

  test("窓に一部でも入るテロップを、元の位置 (index) で返す", () => {
    expect(
      telopsInWindow(
        [span(0, 10), span(18, 22), span(30, 33), span(48, 60), span(70, 80)],
        WINDOW,
      ),
    ).toEqual([1, 2, 3]);
  });

  test("窓の端に接するだけのテロップは入れない (半開区間)", () => {
    expect(telopsInWindow([span(10, 20), span(50, 55)], WINDOW)).toEqual([]);
  });

  test("窓を丸ごと覆うテロップも入れる", () => {
    expect(telopsInWindow([span(0, 100)], WINDOW)).toEqual([0]);
  });
});

describe("assignLanes", () => {
  test("段は最大 2 段 (3 段だと 1440x795 でバーがプレイヤーを覆う)", () => {
    expect(MAX_TELOP_LANES).toBe(2);
  });

  test("重ならなければ全部 1 段目", () => {
    expect(assignLanes([span(0, 5), span(6, 10), span(12, 15)], 2)).toEqual([0, 0, 0]);
  });

  test("重なれば空いている次の段に置く", () => {
    expect(assignLanes([span(0, 5), span(3, 8)], 2)).toEqual([0, 1]);
  });

  test("2 段に入らないテロップは -1 (帯を出さず +N で数える)", () => {
    expect(assignLanes([span(0, 5), span(1, 5), span(2, 5)], 2)).toEqual([0, 1, -1]);
  });

  test("前のテロップの終了ちょうどに始まるテロップは同じ段 (半開区間)", () => {
    expect(assignLanes([span(0, 5), span(5, 8)], 2)).toEqual([0, 0]);
  });

  test("作った順ではなく、開始の早い順に置く", () => {
    expect(assignLanes([span(20, 25), span(10, 30)], 2)).toEqual([1, 0]);
  });

  test("同じ開始なら作った順", () => {
    expect(assignLanes([span(0, 5), span(0, 5), span(0, 5)], 2)).toEqual([0, 1, -1]);
  });

  test("空いた段は前から使う", () => {
    // 3 つ目 (4〜8) は 1 段目 (〜5) とは重なるが、2 段目 (〜3) は空いている
    expect(assignLanes([span(0, 5), span(1, 3), span(4, 8)], 2)).toEqual([0, 1, 1]);
  });

  test("あふれたテロップは段を塞がない", () => {
    // 3 つ目 (2〜3) はあふれる。4 つ目 (10〜12) は 1 段目の終わり (10) から置ける
    expect(
      assignLanes([span(0, 10), span(1, 10), span(2, 3), span(10, 12)], 2),
    ).toEqual([0, 1, -1, 0]);
  });

  test("段の数が 1 未満や整数でなければ throw", () => {
    expect(() => assignLanes([], 0)).toThrow(RangeError);
    expect(() => assignLanes([], 1.5)).toThrow(RangeError);
  });
});

describe("grabKindAt", () => {
  test("幅の広い帯は、端から 6px までが端", () => {
    expect(grabKindAt(0, 60)).toBe("start");
    expect(grabKindAt(5.9, 60)).toBe("start");
    expect(grabKindAt(6, 60)).toBe("move");
    expect(grabKindAt(54, 60)).toBe("move");
    expect(grabKindAt(54.1, 60)).toBe("end");
    expect(grabKindAt(60, 60)).toBe("end");
  });

  test("細い帯は、幅の 1/3 までが端 (中も掴めるように)", () => {
    expect(grabKindAt(2.9, 9)).toBe("start");
    expect(grabKindAt(3, 9)).toBe("move");
    expect(grabKindAt(6, 9)).toBe("move");
    expect(grabKindAt(6.1, 9)).toBe("end");
  });

  test("幅が測れない (0) ときは中", () => {
    expect(grabKindAt(0, 0)).toBe("move");
  });
});

describe("dragTelop", () => {
  /** 拡大バーの窓。テロップは 30〜33 (3 秒) を基本にする */
  const WINDOW = span(20, 50);

  describe("中を掴む (move)", () => {
    test("長さを保って前後に動く", () => {
      expect(dragTelop("move", 30, 33, 5, WINDOW)).toEqual(span(35, 38));
      expect(dragTelop("move", 30, 33, -4, WINDOW)).toEqual(span(26, 29));
    });

    test("窓の終わりで止まる (帯が指の下で消えない)", () => {
      expect(dragTelop("move", 30, 33, 100, WINDOW)).toEqual(span(47, 50));
    });

    test("窓の始まりで止まる", () => {
      expect(dragTelop("move", 30, 33, -100, WINDOW)).toEqual(span(20, 23));
    });
  });

  describe("左端を掴む (start)", () => {
    test("開始だけが動く", () => {
      expect(dragTelop("start", 30, 33, -4, WINDOW)).toEqual(span(26, 33));
    });

    test("終了の 0.5 秒手前で止まる", () => {
      expect(dragTelop("start", 30, 33, 10, WINDOW)).toEqual(span(32.5, 33));
    });

    test("窓の始まりで止まる", () => {
      expect(dragTelop("start", 30, 33, -100, WINDOW)).toEqual(span(20, 33));
    });
  });

  describe("右端を掴む (end)", () => {
    test("終了だけが動く", () => {
      expect(dragTelop("end", 30, 33, 4, WINDOW)).toEqual(span(30, 37));
    });

    test("開始の 0.5 秒後で止まる", () => {
      expect(dragTelop("end", 30, 33, -10, WINDOW)).toEqual(span(30, 30.5));
    });

    test("窓の終わりで止まる", () => {
      expect(dragTelop("end", 30, 33, 100, WINDOW)).toEqual(span(30, 50));
    });
  });

  describe("今の長さが 0.5 秒未満", () => {
    test("今の長さより短くしない (掴んだだけで勝手に伸ばさない)", () => {
      expect(dragTelop("start", 30, 30.25, 5, WINDOW)).toEqual(span(30, 30.25));
      expect(dragTelop("end", 30, 30.25, -5, WINDOW)).toEqual(span(30, 30.25));
    });

    test("伸ばす向きには動く", () => {
      expect(dragTelop("end", 30, 30.25, 1, WINDOW)).toEqual(span(30, 31.25));
    });
  });

  describe("窓からはみ出したテロップ", () => {
    test("窓の始まりより前にはみ出した分はそのまま認め、今より外へは出さない", () => {
      expect(dragTelop("move", 15, 25, -3, WINDOW)).toEqual(span(15, 25));
      expect(dragTelop("start", 15, 25, -3, WINDOW)).toEqual(span(15, 25));
    });

    test("窓の中へは動かせる", () => {
      expect(dragTelop("move", 15, 25, 2, WINDOW)).toEqual(span(17, 27));
    });

    test("窓の終わりより後にはみ出した分も同じ", () => {
      expect(dragTelop("move", 45, 55, 3, WINDOW)).toEqual(span(45, 55));
      expect(dragTelop("end", 45, 55, 3, WINDOW)).toEqual(span(45, 55));
      expect(dragTelop("end", 45, 55, -2, WINDOW)).toEqual(span(45, 53));
    });

    test("少し動かしただけで窓の端へ跳ばない", () => {
      // 窓の始まり (20) より前から始まるテロップを 1 秒右へ。窓の端に揃え直さない
      expect(dragTelop("move", 15, 25, 1, WINDOW)).toEqual(span(16, 26));
    });
  });

  test("動かした量が数でなければ throw", () => {
    expect(() => dragTelop("move", 30, 33, Number.NaN, WINDOW)).toThrow(RangeError);
  });

  test("終了が開始以下なら throw", () => {
    expect(() => dragTelop("move", 33, 30, 1, WINDOW)).toThrow(RangeError);
  });
});
