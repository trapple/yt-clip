// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { TimeWindow } from "@/content/range-math";
import {
  MAX_TELOP_LANES,
  assignLanes,
  createTelopTrack,
  dragTelop,
  grabKindAt,
  telopsInWindow,
  type TelopTrack,
} from "@/content/telop-track";
import type { Telop } from "@/shared/types";

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

/** 窓 0〜40 秒を幅 400px の段の箱に置く (10px/秒) */
const TRACK_WINDOW: TimeWindow = { startSec: 0, endSec: 40 };
const LANES_WIDTH = 400;
/** 帯は 100〜200px (25%〜50%)。中は 106〜194px、左端は 100〜106px、右端は 194〜200px */
const TELOP: Telop = { startSec: 10, endSec: 20, text: "こんにちは" };

function box(left: number, width: number): DOMRect {
  return {
    left,
    width,
    top: 0,
    height: 14,
    right: left + width,
    bottom: 14,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom はレイアウトを持たない。段の箱は幅 400px、帯の箱は style の % から求める
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (!(this instanceof HTMLElement)) return box(0, 0);
    if (this.dataset.role === "telop-lanes") return box(0, LANES_WIDTH);
    if (this.dataset.role === "telop-band") {
      const left = (Number.parseFloat(this.style.left) / 100) * LANES_WIDTH;
      const width = (Number.parseFloat(this.style.width) / 100) * LANES_WIDTH;
      return box(left, width);
    }
    return box(0, 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Harness = {
  track: TelopTrack;
  committed: [number, number, number][];
  played: number[];
  scrubbed: number[];
};

function mountTrack(telops: Telop[], enabled = true): Harness {
  const committed: [number, number, number][] = [];
  const played: number[] = [];
  const scrubbed: number[] = [];
  const track = createTelopTrack({
    onScrub: (sec) => scrubbed.push(sec),
    onCommit: (index, startSec, endSec) => committed.push([index, startSec, endSec]),
    onPlay: (index) => played.push(index),
  });
  document.body.append(track.element);
  track.update(telops, TRACK_WINDOW);
  track.setEnabled(enabled);
  return { track, committed, played, scrubbed };
}

function bandsOf(track: TelopTrack): HTMLElement[] {
  return [...track.element.querySelectorAll<HTMLElement>("[data-role='telop-band']")];
}

function bandAt(track: TelopTrack, position: number): HTMLElement {
  const band = bandsOf(track)[position];
  if (band === undefined) throw new Error(`帯がありません: ${position}`);
  return band;
}

function lanesOf(track: TelopTrack): HTMLElement {
  const lanes = track.element.querySelector<HTMLElement>("[data-role='telop-lanes']");
  if (lanes === null) throw new Error("段の箱がありません");
  return lanes;
}

function overflowOf(track: TelopTrack): HTMLElement {
  const overflow = track.element.querySelector<HTMLElement>("[data-role='telop-overflow']");
  if (overflow === null) throw new Error("+N がありません");
  return overflow;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 7, button: 0 }));
}

/** ドラッグ中のシークは 1 フレームに 1 回に間引かれる。1 フレーム待つ */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("createTelopTrack の見た目", () => {
  test("窓に入るテロップを、拡大バーと同じ時間の軸で帯にする", () => {
    const { track } = mountTrack([TELOP]);

    const band = bandAt(track, 0);
    expect(bandsOf(track)).toHaveLength(1);
    expect(band.style.left).toBe("25%");
    expect(band.style.width).toBe("25%");
    expect(band.textContent).toBe("こんにちは");
    expect(band.dataset.index).toBe("0");
  });

  test("窓の外のテロップは帯にしない。index は元の並びのまま", () => {
    const { track } = mountTrack([{ startSec: 50, endSec: 60, text: "外" }, TELOP]);

    expect(bandsOf(track)).toHaveLength(1);
    expect(bandAt(track, 0).dataset.index).toBe("1");
  });

  test("空の文言は「(未入力)」。改行は 1 行に詰める", () => {
    const { track } = mountTrack([
      { startSec: 10, endSec: 20, text: "" },
      { startSec: 21, endSec: 25, text: "一行目\n二行目" },
    ]);

    expect(bandsOf(track).map((band) => band.textContent)).toEqual([
      "(未入力)",
      "一行目 二行目",
    ]);
  });

  test("左右に拡大バーと同じ時刻を置いて、帯の段をトラックの左右に揃える", () => {
    const { track } = mountTrack([TELOP]);

    expect(track.element.children[0]?.textContent).toBe("0:00");
    expect(track.element.children[1]).toBe(lanesOf(track));
    expect(track.element.children[2]?.firstElementChild?.textContent).toBe("0:40");
  });

  test("重なるテロップは段を分ける (段の高さ 14px・段の間 2px)", () => {
    const { track } = mountTrack([TELOP, { startSec: 15, endSec: 25, text: "やあ" }]);

    expect(bandsOf(track).map((band) => band.style.top)).toEqual(["0px", "16px"]);
    expect(bandsOf(track).map((band) => band.dataset.lane)).toEqual(["0", "1"]);
  });

  test("2 段に入らない分は帯を出さず、右端に「+N」だけ出す", () => {
    const { track } = mountTrack([
      TELOP,
      { startSec: 12, endSec: 18, text: "b" },
      { startSec: 14, endSec: 16, text: "c" },
      { startSec: 15, endSec: 19, text: "d" },
    ]);

    expect(bandsOf(track)).toHaveLength(2);
    expect(overflowOf(track).hidden).toBe(false);
    expect(overflowOf(track).textContent).toBe("+2");
  });

  test("あふれが無ければ「+N」を隠す", () => {
    const { track } = mountTrack([TELOP]);

    expect(overflowOf(track).hidden).toBe(true);
  });

  test("テロップが 1 つも無ければ段ごと隠す (バーを高くしない)", () => {
    const { track } = mountTrack([]);

    expect(track.element.hidden).toBe(true);
    expect(track.element.style.display).toBe("none");

    track.update([TELOP], TRACK_WINDOW);

    expect(track.element.hidden).toBe(false);
    expect(track.element.style.display).toBe("flex");
  });

  test("「+N」を押しても何も起きない (一覧で直す)", () => {
    const { track, committed, played } = mountTrack([
      TELOP,
      { startSec: 12, endSec: 18, text: "b" },
      { startSec: 14, endSec: 16, text: "c" },
    ]);

    pointer(overflowOf(track), "pointerdown", 410);
    pointer(overflowOf(track), "pointerup", 410);
    overflowOf(track).click();

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
  });

  test("生成直後は動かせない (薄く出す)", () => {
    // 呼び出し側が setEnabled を呼び忘れても、編集できない状態で動かさない
    const track = createTelopTrack({
      onScrub: () => undefined,
      onCommit: () => undefined,
      onPlay: () => undefined,
    });

    expect(track.element.style.opacity).toBe("0.4");
    expect(lanesOf(track).style.pointerEvents).toBe("none");
  });
});

describe("帯のドラッグ", () => {
  test("中を掴むと長さを保って動き、指を離したときに 1 回だけ onCommit", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);
    // 動かしている間は送らない (区間の拡大バーと同じ。往復を増やさない)
    expect(committed).toEqual([]);
    pointer(band, "pointerup", 250);

    // 100px = 10 秒
    expect(committed).toEqual([[0, 20, 30]]);
    // 状態の通知が返るまでも、離した場所に帯を残す
    expect(bandAt(track, 0).style.left).toBe("50%");
  });

  test("左端を掴むと開始だけが動く", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 102);
    pointer(band, "pointermove", 82);
    pointer(band, "pointerup", 82);

    expect(committed).toEqual([[0, 8, 20]]);
  });

  test("右端を掴むと終了だけが動く", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 197);
    pointer(band, "pointermove", 217);
    pointer(band, "pointerup", 217);

    expect(committed).toEqual([[0, 10, 22]]);
  });

  test("中を掴んで動かすと、開始の位置へシークする", async () => {
    const { track, scrubbed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    await nextFrame();
    pointer(band, "pointerup", 170);

    expect(scrubbed).toEqual([12]);
  });

  test("右端を掴んで動かすと、終了の位置へシークする", async () => {
    const { track, scrubbed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 197);
    pointer(band, "pointermove", 217);
    await nextFrame();
    pointer(band, "pointerup", 217);

    expect(scrubbed).toEqual([22]);
  });

  test("4px 未満しか動かさずに離すと、そのテロップの頭から再生する (onPlay)", () => {
    const { track, committed, played } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 153);
    pointer(band, "pointerup", 153);

    expect(played).toEqual([0]);
    expect(committed).toEqual([]);
  });

  test("4px 以上動かしてから元の場所へ戻して離したら、送らず再生もしない", () => {
    const { track, committed, played } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    pointer(band, "pointermove", 150);
    pointer(band, "pointerup", 150);

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
  });

  test("窓の外へは動かさない", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 1000);
    pointer(band, "pointerup", 1000);

    expect(committed).toEqual([[0, 30, 40]]);
  });

  test("無効な間は動かず、押して離しても再生しない (薄く出す)", () => {
    const { track, committed, played } = mountTrack([TELOP], false);
    const band = bandAt(track, 0);

    expect(track.element.style.opacity).toBe("0.4");
    expect(lanesOf(track).style.pointerEvents).toBe("none");

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    pointer(band, "pointerup", 170);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointerup", 150);

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
  });

  test("ドラッグ中に無効になったら打ち切り、帯を元の位置に戻す", () => {
    // 録画が始まった後もシークし続けると、録画された映像に飛びが入る
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);
    expect(band.style.left).toBe("50%");

    track.setEnabled(false);
    pointer(band, "pointerup", 250);

    expect(committed).toEqual([]);
    expect(bandAt(track, 0).style.left).toBe("25%");
  });

  test("ドラッグ中に届いた update は、指を離してから描く", () => {
    // 描き直すと掴んでいる帯が作り直され、ポインタの捕捉が外れる
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);

    track.update([{ ...TELOP, text: "やあ" }], TRACK_WINDOW);

    expect(bandAt(track, 0)).toBe(band);
    expect(band.textContent).toBe("こんにちは");

    pointer(band, "pointerup", 250);

    expect(committed).toEqual([[0, 20, 30]]);
    // 届いていた文言に、離した時刻を載せて描く
    expect(bandAt(track, 0).textContent).toBe("やあ");
    expect(bandAt(track, 0).style.left).toBe("50%");
  });

  test("ドラッグ中に届いた update で掴んだテロップが入れ替わったら、確定しない", () => {
    // 一覧の ✕ で前のテロップが消えると index がずれる。別のテロップに時刻を載せて送らない
    const { track, committed, played } = mountTrack([TELOP]);
    const band = bandAt(track, 0);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);

    track.update([{ startSec: 30, endSec: 35, text: "別" }], TRACK_WINDOW);
    pointer(band, "pointerup", 250);

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
    // 届いていた update のとおりに描く
    expect(bandAt(track, 0).textContent).toBe("別");
    expect(bandAt(track, 0).style.left).toBe("75%");
  });

  test("指を離した後は、予約済みのシークも走らせない", async () => {
    // 1 フレーム後に動画が飛ぶと、元へ戻して離したときに見た目と違う位置で止まる
    const { track, scrubbed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    pointer(band, "pointerup", 170);
    await nextFrame();

    expect(scrubbed).toEqual([]);
  });

  test("destroy すると要素が DOM から外れる", () => {
    const { track } = mountTrack([TELOP]);

    track.destroy();

    expect(document.body.contains(track.element)).toBe(false);
  });
});
