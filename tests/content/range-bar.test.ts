// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { createRangeBar, type RangeBar } from "@/content/range-bar";
import type { ClipRange } from "@/shared/types";

function makeBar(): { bar: RangeBar; committed: ClipRange[] } {
  const committed: ClipRange[] = [];
  const bar = createRangeBar({
    onScrub: () => undefined,
    onCommit: (range) => committed.push(range),
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
