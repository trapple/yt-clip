// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { createRangeBar, type RangeBar } from "@/content/range-bar";
import type { ClipRange } from "@/shared/types";

function makeBar(): { bar: RangeBar; committed: ClipRange[] } {
  const committed: ClipRange[] = [];
  const bar = createRangeBar({
    onScrub: () => undefined,
    onCommit: (range) => committed.push(range),
    onSeekPlay: () => undefined,
  });
  document.body.append(bar.element);
  return { bar, committed };
}

/** ハンドルに付く説明。paint() の結果を外から見られる唯一の手がかり */
function handleLabels(bar: RangeBar): string[] {
  return [...bar.element.querySelectorAll("[aria-label]")].map(
    (element) => element.getAttribute("aria-label") ?? "",
  );
}

describe("createRangeBar", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("生成直後は操作を受け付けない", () => {
    // spec §5.3 のとおり、範囲が確定するまで操作させない。
    // 初期の範囲と窓はどちらも幅 0 で、この状態で掴めてしまうと
    // 動かせる余地が無いまま負の再生位置が生まれ、描画が throw する。
    // **呼び出し側が setEnabled(false) を忘れても守られること**を固定する
    const { bar } = makeBar();
    expect(bar.element.style.pointerEvents).toBe("none");
  });

  test("有効化と無効化で操作の可否が切り替わる", () => {
    const { bar } = makeBar();

    bar.setEnabled(true);
    expect(bar.element.style.pointerEvents).not.toBe("none");

    bar.setEnabled(false);
    expect(bar.element.style.pointerEvents).toBe("none");
  });

  test("update した範囲と窓が表示に出る", () => {
    const { bar } = makeBar();
    bar.update({ startSec: 100, endSec: 130 }, 600);

    expect(handleLabels(bar)).toEqual(["開始 1:40", "終了 2:10"]);
    // 窓は範囲の前後に余裕を持たせた 60 秒 (85 〜 145)
    expect(bar.element.textContent).toContain("1:25");
    expect(bar.element.textContent).toContain("2:25");
  });

  test("destroy すると要素が DOM から外れる", () => {
    // YouTube の再描画でバーが消えたとき、古いインスタンスを捨てる経路。
    // 捨てないと rAF とリスナを抱えたまま残る
    const { bar } = makeBar();
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

  function makeBar(): RangeBar {
    const bar = createRangeBar({
      onScrub: () => undefined,
      onCommit: () => undefined,
      onSeekPlay: () => undefined,
    });
    // 窓は範囲の 2 倍か 30 秒の広い方。ここでは 30 秒 (22.5〜52.5)
    bar.update({ startSec: 30, endSec: 45 }, 600);
    return bar;
  }

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
  /** 窓は 22.5〜52.5 秒 (範囲 15 秒の 2 倍か 30 秒の広い方) */
  function makeBar(): {
    bar: RangeBar;
    seeked: number[];
    committed: ClipRange[];
    track: HTMLElement;
    handles: HTMLElement[];
  } {
    const seeked: number[] = [];
    const committed: ClipRange[] = [];
    const bar = createRangeBar({
      onScrub: () => undefined,
      onCommit: (range) => committed.push(range),
      onSeekPlay: (sec) => seeked.push(sec),
    });
    document.body.append(bar.element);
    bar.update({ startSec: 30, endSec: 45 }, 600);

    const track = bar.element.querySelector<HTMLElement>("[data-role=track]");
    if (track === null) throw new Error("トラックがありません");
    // jsdom はレイアウトを持たないので、割合の計算に必要な幅を与える
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 100 }) as DOMRect;

    const handles = [...bar.element.querySelectorAll<HTMLElement>("[aria-label]")];
    for (const handle of handles) {
      // jsdom の setPointerCapture は pointerId を検証して投げる。
      // ここで見たいのはドラッグの成否ではなく、再生が始まらないこと
      handle.setPointerCapture = () => undefined;
      handle.releasePointerCapture = () => undefined;
    }

    return { bar, seeked, committed, track, handles };
  }

  function pressAt(target: HTMLElement, clientX: number): void {
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX }),
    );
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("押した位置の再生位置を返す", () => {
    const { bar, track, seeked } = makeBar();
    bar.setEnabled(true);

    pressAt(track, 50);

    // 窓 22.5〜52.5 の中央
    expect(seeked).toEqual([37.5]);
  });

  test("範囲は変えない", () => {
    // IN/OUT を動かす操作ではない。押しただけで範囲が確定してしまうと、
    // 見ようとしただけで切り抜く場所が変わる
    const { bar, track, seeked, committed } = makeBar();
    bar.setEnabled(true);

    pressAt(track, 90);

    expect(seeked).toHaveLength(1);
    expect(committed).toEqual([]);
    expect(handleLabels(bar)).toEqual(["開始 0:30", "終了 0:45"]);
  });

  test("ハンドルを掴んだときは再生しない", () => {
    // ハンドルはトラックの子なので、何もしないと掴むたびに再生が始まる
    const { bar, handles, seeked } = makeBar();
    bar.setEnabled(true);

    for (const handle of handles) pressAt(handle, 50);

    expect(seeked).toEqual([]);
  });

  test("操作を受け付けない間は再生しない", () => {
    // 録画中にシークすると、録画された映像に飛びが入る
    const { bar, track, seeked } = makeBar();
    bar.setEnabled(true);
    bar.setEnabled(false);

    pressAt(track, 50);

    expect(seeked).toEqual([]);
  });

  test("窓の外を押しても窓の中に収まる", () => {
    const { bar, track, seeked } = makeBar();
    bar.setEnabled(true);

    pressAt(track, -20);

    expect(seeked).toEqual([22.5]);
  });
});

describe("最大秒数", () => {
  /** ハンドルを掴んで動かす。jsdom は捕捉 API を持たないので差し替える */
  function dragOut(bar: RangeBar, clientX: number): void {
    const handles = [...bar.element.querySelectorAll<HTMLElement>("[aria-label]")];
    const outHandle = handles[1];
    if (outHandle === undefined) throw new Error("終了ハンドルがありません");
    outHandle.setPointerCapture = () => undefined;
    outHandle.releasePointerCapture = () => undefined;

    outHandle.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 0 }),
    );
    outHandle.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX }),
    );
  }

  /**
   * 窓を 0〜100 秒にして開く (範囲 50 秒の 2 倍)。
   * **窓は `update` でしか変わらない。** 窓より上限を小さく取らないと、
   * 見ているのが上限なのか窓の端なのか区別が付かない
   */
  function makeBar(): RangeBar {
    const bar = createRangeBar({
      onScrub: () => undefined,
      onCommit: () => undefined,
      onSeekPlay: () => undefined,
    });
    document.body.append(bar.element);
    bar.update({ startSec: 0, endSec: 50 }, 300);
    const track = bar.element.querySelector<HTMLElement>("[data-role=track]");
    if (track === null) throw new Error("トラックがありません");
    // 幅 300px が窓の 100 秒に対応する
    track.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    bar.setEnabled(true);
    return bar;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("設定した上限までしか伸びない", () => {
    // 計算 (clampHandle) は range-math で固めてある。ここで見るのは
    // 設定した値がドラッグまで届いているかという繋ぎ込み
    const bar = makeBar();
    bar.setMaxClipSec(20);

    // 窓の右端 (100 秒) まで引っ張る
    dragOut(bar, 300);

    expect(handleLabels(bar)).toEqual(["開始 0:00", "終了 0:20"]);
  });

  test("上限を変えれば結果も変わる", () => {
    const bar = makeBar();
    bar.setMaxClipSec(20);
    dragOut(bar, 300);

    bar.setMaxClipSec(60);
    dragOut(bar, 300);

    expect(handleLabels(bar)).toEqual(["開始 0:00", "終了 1:00"]);
  });
});
