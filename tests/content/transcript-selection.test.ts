import { describe, expect, test } from "vitest";
import {
  isLineInSegments,
  lineIdsBetween,
  setLinesSelected,
  toggleTelopHidden,
  type Clip,
} from "@/content/transcript-selection";
import type { TranscriptLine } from "@/shared/transcript";

/** 2 秒ずつ、1 秒の間を空けて並ぶ行 (0-2, 3-5, 6-8, …, 57-59) */
const lines: TranscriptLine[] = Array.from({ length: 20 }, (_, i) => ({
  id: `l${i}`,
  startSec: i * 3,
  endSec: i * 3 + 2,
  text: `行 ${i}`,
}));
const empty: Clip = { segments: [], telops: [] };
const pick = (clip: Clip, ids: string[], on = true): Clip => setLinesSelected(clip, lines, ids, on);
const tight: TranscriptLine[] = [
  { id: "a", startSec: 0, endSec: 2, text: "a" },
  { id: "b", startSec: 2.1, endSec: 4, text: "b" },
  { id: "c", startSec: 4.1, endSec: 6, text: "c" },
];
const lineIds = (clip: Clip): (string | undefined)[] => clip.telops.map((telop) => telop.lineId);

describe("isLineInSegments", () => {
  test("行の半分以上が区間に重なれば入っている", () => {
    expect(isLineInSegments(lines[1]!, [{ startSec: 3.9, endSec: 10 }])).toBe(true);
    expect(isLineInSegments(lines[1]!, [{ startSec: 4.1, endSec: 10 }])).toBe(false);
  });
});

describe("setLinesSelected: 入れる", () => {
  test("行を 1 つ入れると、頭 0.2 秒・尻 0.3 秒の余白の区間と、行の文字のテロップができる", () => {
    expect(pick(empty, ["l1"])).toEqual({
      segments: [{ startSec: 2.8, endSec: 5.3 }],
      telops: [{ startSec: 3, endSec: 5, text: "行 1", lineId: "l1" }],
    });
  });

  test("余白は隣の行に食い込まない", () => {
    expect(setLinesSelected(empty, tight, ["b"], true).segments).toEqual([{ startSec: 2, endSec: 4.1 }]);
  });

  test("1 秒に満たない区間は、前後へ広げて 1 秒にする", () => {
    const short: TranscriptLine[] = [{ id: "s", startSec: 10, endSec: 10.3, text: "はい" }];
    expect(setLinesSelected(empty, short, ["s"], true).segments).toEqual([{ startSec: 9.7, endSec: 10.7 }]);
  });

  test("隣の行を入れると 1 つの区間に伸びる。間を埋めると 2 つが 1 つになる", () => {
    const two = pick(pick(empty, ["l1"]), ["l3"]);
    expect(two.segments).toHaveLength(2);
    const joined = pick(two, ["l2"]);
    expect(joined.segments).toEqual([{ startSec: 2.8, endSec: 11.3 }]);
    // テロップは足した順に末尾へ積む (テロップの一覧の並びを動かさない)
    expect(lineIds(joined)).toEqual(["l1", "l3", "l2"]);
  });

  test("行の間が 3 秒より空いていれば、隣の行でも別の区間にする", () => {
    const gap: TranscriptLine[] = [
      { id: "a", startSec: 0, endSec: 2, text: "a" },
      { id: "b", startSec: 10, endSec: 12, text: "b" },
    ];
    expect(setLinesSelected(empty, gap, ["a", "b"], true).segments).toEqual([
      { startSec: 0, endSec: 2.3 },
      { startSec: 9.8, endSec: 12.3 },
    ]);
  });

  test("直したテロップの文字は、行を入れたままなら残る", () => {
    const one = pick(empty, ["l1"]);
    const edited: Clip = { ...one, telops: [{ ...one.telops[0]!, text: "直した" }] };
    expect(pick(edited, ["l4"]).telops.find((telop) => telop.lineId === "l1")?.text).toBe("直した");
  });

  test("詰めた区間は、離れた行を足しても触らない。隣の行を足しても詰めた頭は残る", () => {
    const trimmed: Clip = { segments: [{ startSec: 3.1, endSec: 4.9 }], telops: [] };
    expect(pick(trimmed, ["l4"]).segments[0]).toEqual({ startSec: 3.1, endSec: 4.9 });
    expect(pick(trimmed, ["l2"]).segments).toEqual([{ startSec: 3.1, endSec: 8.3 }]);
  });

  test("行に重ならない区間 (＋ 区間を追加で作った) と、手で足したテロップはそのまま残す", () => {
    const manual: Clip = {
      segments: [{ startSec: 100, endSec: 115 }],
      telops: [{ startSec: 101, endSec: 104, text: "手で足した" }],
    };
    const next = pick(manual, ["l0"]);
    expect(next.segments).toEqual([
      { startSec: 0, endSec: 2.3 },
      { startSec: 100, endSec: 115 },
    ]);
    expect(next.telops[0]).toEqual({ startSec: 101, endSec: 104, text: "手で足した" });
  });

  test("行に重なる手作りの区間も、押した行に当たらなければ触らない。中の行にテロップを作らない", () => {
    const manual: Clip = {
      segments: [
        { startSec: 10, endSec: 25 },
        { startSec: 25, endSec: 40 },
      ],
      telops: [{ startSec: 12, endSec: 14, text: "手" }],
    };
    const next = pick(manual, ["l18"]);
    expect(next.segments).toEqual([
      { startSec: 10, endSec: 25 },
      { startSec: 25, endSec: 40 },
      { startSec: 53.8, endSec: 56.3 },
    ]);
    expect(next.telops.map((telop) => telop.text)).toEqual(["手", "行 18"]);
  });

  test("重ねた区間は、離れた行を押しても両方残る", () => {
    const twice: Clip = {
      segments: [
        { startSec: 2.8, endSec: 5.3 },
        { startSec: 2.8, endSec: 5.3 },
      ],
      telops: [],
    };
    expect(pick(twice, ["l4"]).segments).toHaveLength(3);
  });

  test("詰めて半分を割った行のテロップは、関係の無い行を押しても消えない", () => {
    const clip: Clip = {
      segments: [{ startSec: 4.5, endSec: 5.3 }],
      telops: [{ startSec: 3, endSec: 5, text: "直した", lineId: "l1" }],
    };
    expect(pick(clip, ["l4"]).telops[0]).toEqual({ startSec: 3, endSec: 5, text: "直した", lineId: "l1" });
  });

  test("区間は動画の終わりを越えない。越える行は終わりから 1 秒にする", () => {
    expect(setLinesSelected(empty, lines, ["l19"], true, 59.1).segments).toEqual([{ startSec: 56.8, endSec: 59.1 }]);
    const over: TranscriptLine[] = [{ id: "z", startSec: 58.5, endSec: 61, text: "z" }];
    expect(setLinesSelected(empty, over, ["z"], true, 59).segments).toEqual([{ startSec: 58, endSec: 59 }]);
  });

  test("1 秒に広げた区間は、丸めても 1 秒を割らない", () => {
    for (let ms = 0; ms < 3000; ms += 10) {
      const start = ms / 1000;
      const short: TranscriptLine[] = [{ id: "s", startSec: start, endSec: start + 0.3, text: "s" }];
      const [segment] = setLinesSelected(empty, short, ["s"], true).segments;
      expect(Math.round((segment!.endSec - segment!.startSec) * 100)).toBeGreaterThanOrEqual(100);
    }
  });

  test("テロップの文字は 500 文字で切る", () => {
    const long: TranscriptLine[] = [{ id: "x", startSec: 0, endSec: 2, text: "あ".repeat(600) }];
    expect(setLinesSelected(empty, long, ["x"], true).telops[0]?.text).toHaveLength(500);
  });

  test("知らない行の id は無視する", () => {
    expect(pick(empty, ["nope"])).toEqual(empty);
  });
});

describe("setLinesSelected: 外す", () => {
  test("途中の行を外すと 2 つに割れ、外した行のテロップだけ消える", () => {
    const three = pick(empty, ["l1", "l2", "l3"]);
    expect(three.segments).toEqual([{ startSec: 2.8, endSec: 11.3 }]);
    const split = pick(three, ["l2"], false);
    expect(split.segments).toEqual([
      { startSec: 2.8, endSec: 5.3 },
      { startSec: 8.8, endSec: 11.3 },
    ]);
    expect(lineIds(split)).toEqual(["l1", "l3"]);
  });

  test("最後の行を外すと区間もテロップも無くなる。まとめて外しても同じ", () => {
    expect(pick(pick(empty, ["l1"]), ["l1"], false)).toEqual(empty);
    expect(pick(pick(empty, ["l1", "l2", "l3"]), ["l1", "l2", "l3"], false)).toEqual(empty);
  });

  test("外した残りが 1 秒に満たなくても、まだ入っている短い行があれば 1 秒に広げて残す", () => {
    const short: TranscriptLine[] = [
      { id: "a", startSec: 0, endSec: 2, text: "a" },
      { id: "b", startSec: 2.1, endSec: 4, text: "b" },
      { id: "c", startSec: 4.1, endSec: 4.6, text: "はい" },
    ];
    const both = setLinesSelected(empty, short, ["b", "c"], true);
    const next = setLinesSelected(both, short, ["b"], false);
    expect(next.segments).toEqual([{ startSec: 4, endSec: 5 }]);
    expect(lineIds(next)).toEqual(["c"]);
  });

  test("手作りの区間の中の行を外すと、そこだけ切り取る。外側の端は残し、残った行にテロップを作らない", () => {
    const manual: Clip = { segments: [{ startSec: 10, endSec: 25 }], telops: [{ startSec: 12, endSec: 14, text: "手" }] };
    expect(pick(manual, ["l5"], false)).toEqual({
      segments: [
        { startSec: 10, endSec: 14.3 },
        { startSec: 17.8, endSec: 25 },
      ],
      telops: [{ startSec: 12, endSec: 14, text: "手" }],
    });
  });
});

test("lineIdsBetween は並び順で両端を含む。逆向きでもよい", () => {
  expect(lineIdsBetween(lines, "l1", "l3")).toEqual(["l1", "l2", "l3"]);
  expect(lineIdsBetween(lines, "l3", "l1")).toEqual(["l1", "l2", "l3"]);
  expect(lineIdsBetween(lines, "nope", "l2")).toEqual(["l2"]);
});

describe("toggleTelopHidden", () => {
  test("文字を空にして出さない。もう一度で行の文字に戻す", () => {
    const one = pick(empty, ["l1"]);
    const hidden = toggleTelopHidden(one, lines[1]!);
    expect(hidden?.telops[0]?.text).toBe("");
    expect(hidden?.segments).toEqual(one.segments);
    expect(toggleTelopHidden(hidden!, lines[1]!)?.telops[0]?.text).toBe("行 1");
  });

  test("その行のテロップが無ければ null", () => {
    expect(toggleTelopHidden(empty, lines[1]!)).toBeNull();
  });
});
