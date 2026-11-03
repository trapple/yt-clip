// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { createRangeBar, type RangeBar } from "@/content/range-bar";
import {
  dragHandle,
  handleLabels,
  mountRangeBar,
  pressAt,
} from "../helpers/range-bar";

/** バー要素に対する説明の取り出し。ヘルパへの薄い橋渡し */
function labelsOf(bar: RangeBar): string[] {
  return handleLabels(bar.element);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createRangeBar", () => {
  test("生成直後は操作を受け付けない", () => {
    // spec §5.3 のとおり、範囲が確定するまで操作させない。
    // 初期の範囲と窓はどちらも幅 0 で、この状態で掴めてしまうと
    // 動かせる余地が無いまま負の再生位置が生まれ、描画が throw する。
    // **呼び出し側が setEnabled(false) を忘れても守られること**を固定する
    const { bar } = mountRangeBar();
    expect(bar.element.style.pointerEvents).toBe("none");
  });

  test("有効化と無効化で操作の可否が切り替わる", () => {
    const { bar } = mountRangeBar();

    bar.setEnabled(true);
    expect(bar.element.style.pointerEvents).not.toBe("none");

    bar.setEnabled(false);
    expect(bar.element.style.pointerEvents).toBe("none");
  });

  test("update した範囲と窓が表示に出る", () => {
    const { bar } = mountRangeBar({ range: { startSec: 100, endSec: 130 } });

    expect(labelsOf(bar)).toEqual(["開始 1:40", "終了 2:10"]);
    // 窓は範囲の前後 2 秒 (98 〜 132)
    expect(bar.element.textContent).toContain("1:38");
    expect(bar.element.textContent).toContain("2:12");
  });

  test("destroy すると要素が DOM から外れる", () => {
    // YouTube の再描画でバーが消えたとき、古いインスタンスを捨てる経路。
    // 捨てないと rAF とリスナを抱えたまま残る
    const { bar } = mountRangeBar();
    expect(document.body.contains(bar.element)).toBe(true);

    bar.destroy();

    expect(document.body.contains(bar.element)).toBe(false);
  });
});

describe("現在の再生位置", () => {
  function playheadOf(bar: RangeBar): HTMLElement {
    const element = bar.element.querySelector<HTMLElement>(
      "[data-role=playhead]",
    );
    if (element === null) throw new Error("再生位置の目印がありません");
    return element;
  }

  /** 窓は範囲の前後 2 秒。既定の範囲では 28〜47 */
  const makeBar = (): RangeBar => mountRangeBar().bar;

  test("窓の中なら位置を示す", () => {
    const bar = makeBar();

    bar.setPlayhead(37.5);

    expect(playheadOf(bar).hidden).toBe(false);
    expect(playheadOf(bar).style.left).toBe("50%");
  });

  test("窓の外なら隠す", () => {
    // 潰れた目盛りを出すより、出さない方が正確
    const bar = makeBar();

    bar.setPlayhead(5);

    expect(playheadOf(bar).hidden).toBe(true);
  });

  test("位置が分からないときは隠す", () => {
    const bar = makeBar();
    bar.setPlayhead(37.5);

    bar.setPlayhead(null);

    expect(playheadOf(bar).hidden).toBe(true);
  });
});

describe("トラックのクリックで再生", () => {
  /** 窓は範囲 30〜45 の前後 2 秒 (28〜47)。幅 100px がその 19 秒に対応する */
  const enabledBar = () => mountRangeBar({ enabled: true });

  test("押した位置の再生位置を返す", () => {
    const { track, seeked } = enabledBar();

    pressAt(track, 50);

    // 窓 28〜47 の中央
    expect(seeked).toEqual([37.5]);
  });

  test("範囲は変えない", () => {
    // IN/OUT を動かす操作ではない。押しただけで範囲が確定してしまうと、
    // 見ようとしただけで切り抜く場所が変わる
    const { bar, track, seeked, committed } = enabledBar();

    pressAt(track, 90);

    expect(seeked).toHaveLength(1);
    expect(committed).toEqual([]);
    expect(labelsOf(bar)).toEqual(["開始 0:30", "終了 0:45"]);
  });

  test("ハンドルを掴んだときは再生しない", () => {
    // ハンドルはトラックの子なので、何もしないと掴むたびに再生が始まる
    const { handles, seeked } = enabledBar();

    for (const handle of handles) pressAt(handle, 50);

    expect(seeked).toEqual([]);
  });

  test("操作を受け付けない間は再生しない", () => {
    // 録画中にシークすると、録画された映像に飛びが入る
    const { bar, track, seeked } = enabledBar();
    bar.setEnabled(false);

    pressAt(track, 50);

    expect(seeked).toEqual([]);
  });

  test("窓の外を押しても窓の中に収まる", () => {
    const { track, seeked } = enabledBar();

    pressAt(track, -20);

    expect(seeked).toEqual([28]);
  });
});

describe("最大秒数", () => {
  /**
   * 窓を 0〜61 秒にして開く (範囲 0〜59 の前後 2 秒。頭は動画の頭で切る)。
   * **窓は `update` でしか変わらない。** 窓より上限を小さく取らないと、
   * 見ているのが上限なのか窓の端なのか区別が付かない
   */
  const wideBar = (maxClipSec: number) =>
    mountRangeBar({
      range: { startSec: 0, endSec: 59 },
      videoDurationSec: 300,
      trackWidth: 300,
      maxClipSec,
      enabled: true,
    });

  test("設定した上限までしか伸びない", () => {
    // 計算 (clampHandle) は range-math で固めてある。ここで見るのは
    // 設定した値がドラッグまで届いているかという繋ぎ込み
    const { bar, handles } = wideBar(20);

    // 窓の右端 (61 秒) まで引っ張る
    dragHandle(handles[1], 300);

    expect(labelsOf(bar)).toEqual(["開始 0:00", "終了 0:20"]);
  });

  test("上限を変えれば結果も変わる", () => {
    // **ドラッグのたびに引く。** 値を渡す形だと、設定が変わったときと
    // バーを作り直したときの両方で流し込み直す義務が呼び出し側に残る
    const { bar, handles, maxClipSec } = wideBar(20);
    dragHandle(handles[1], 300);

    maxClipSec.value = 60;
    dragHandle(handles[1], 300);

    expect(labelsOf(bar)).toEqual(["開始 0:00", "終了 1:00"]);
  });
});

describe("時間の窓 (テロップの帯が同じ軸で読む)", () => {
  test("update する前は null (幅 0 の窓を軸にさせない)", () => {
    const bar = createRangeBar({
      onScrub: () => undefined,
      onCommit: () => undefined,
      onSeekPlay: () => undefined,
      maxClipSec: () => 60,
      // 吸い付き先と掴んだ端は、このテストでは使わない
      snapPoints: () => [],
      onGrab: () => undefined,
    });

    expect(bar.window()).toBeNull();
  });

  test("update した範囲から決めた窓を返す", () => {
    // 範囲 30〜45 の窓は前後 2 秒 (28〜47)
    const { bar } = mountRangeBar();

    expect(bar.window()).toEqual({ startSec: 28, endSec: 47 });
  });

  test("返した窓を書き換えても、拡大バーの窓は変わらない", () => {
    const { bar } = mountRangeBar();
    const read = bar.window();
    if (read === null) throw new Error("窓がありません");

    read.startSec = 0;

    expect(bar.window()).toEqual({ startSec: 28, endSec: 47 });
  });
});

describe("単語の切れ目への吸い付き", () => {
  // 既定の範囲 30〜45 の窓は 28〜47 (19 秒)。トラックを 190px にして 1px = 0.1 秒にする。SNAP_PX (8px) は 0.8 秒
  test("近くの切れ目に寄せる", () => {
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [31] });
    dragHandle(handles[0], 33); // 28 + 3.3 = 31.3 秒
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)).toEqual({ startSec: 31, endSec: 45 });
  });

  test("Alt を押している間は吸い付かない", () => {
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [31] });
    dragHandle(handles[0], 33, 0, true);
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)?.startSec).toBeCloseTo(31.3, 5);
  });

  test("遠い切れ目には寄せない", () => {
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [35] });
    dragHandle(handles[0], 33);
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)?.startSec).toBeCloseTo(31.3, 5);
  });

  test("寄せた後も最小・最大の長さを守る", () => {
    // 尻 45 の 0.5 秒手前に切れ目。寄せると 0.5 秒の区間になるので、1 秒手前で止める
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [44.5] });
    dragHandle(handles[0], 165); // 28 + 16.5 = 44.5 秒
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)).toEqual({ startSec: 44, endSec: 45 });
  });
});

describe("掴んだ端", () => {
  test("ハンドルを掴むと、どちらの端かを知らせる", () => {
    const { handles, grabbed } = mountRangeBar({ enabled: true });
    pressAt(handles[1], 0);
    pressAt(handles[0], 0);
    expect(grabbed).toEqual(["out", "in"]);
  });

  test("操作を受け付けない間は知らせない", () => {
    const { handles, grabbed } = mountRangeBar({ enabled: false });
    pressAt(handles[1], 0);
    expect(grabbed).toEqual([]);
  });
});
