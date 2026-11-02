// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import {
  createTranscriptPanel,
  type TranscriptPanelCallbacks,
  type TranscriptView,
} from "@/content/transcript-panel";

function setup(overrides: Partial<TranscriptPanelCallbacks> = {}) {
  const callbacks: TranscriptPanelCallbacks = {
    onToggle: vi.fn(),
    onEditText: vi.fn(() => true),
    onToggleHidden: vi.fn(),
    onPlay: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  const panel = createTranscriptPanel(callbacks);
  document.body.replaceChildren(panel.element);
  return { panel, callbacks };
}

const view = (overrides: Partial<TranscriptView> = {}): TranscriptView => ({
  header: { kind: "ready", label: "公式字幕 (自動)" },
  dubbed: false,
  enabled: true,
  rows: [
    { id: "a", startSec: 1, text: "さあ残り 30 秒", selected: false, hidden: false, hasTelop: false },
    { id: "b", startSec: 65, text: "ここは絶対に右から", selected: true, hidden: false, hasTelop: true },
    { id: "c", startSec: 70, text: "えーと", selected: true, hidden: true, hasTelop: true },
  ],
  ...overrides,
});

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-role='line']")];
const role = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-role='${name}']`);
const part = (index: number, name: string): HTMLElement | null =>
  rows()[index]?.querySelector<HTMLElement>(`[data-role='${name}']`) ?? null;
const editor = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']");
const key = (target: Element, init: KeyboardEventInit): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
};

describe("行を描く", () => {
  test("時刻と文字を出し、選んでいる行・出さない行に印を付ける", () => {
    const { panel } = setup();
    panel.update(view());
    expect(rows().map((row) => row.dataset.lineId)).toEqual(["a", "b", "c"]);
    expect(rows().map((_, i) => part(i, "line-time")?.textContent)).toEqual(["0:01", "1:05", "1:10"]);
    expect(rows().map((row) => row.dataset.selected)).toEqual(["false", "true", "true"]);
    expect(rows().map((row) => row.dataset.hidden)).toEqual(["false", "false", "true"]);
    expect(role("transcript-source")?.textContent).toBe("公式字幕 (自動)");
  });

  test("文字はタグとして解釈しない (textContent)", () => {
    const { panel } = setup();
    panel.update(view({ rows: [{ id: "x", startSec: 0, text: "<img src=x onerror=alert(1)>", selected: false, hidden: false, hasTelop: false }] }));
    expect(document.querySelector("img")).toBeNull();
    expect(part(0, "line-text")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  test("選んでいる行にだけ ✎ と「字幕に出さない」があり、出さない行は「字幕に出す」", () => {
    const { panel } = setup();
    panel.update(view());
    expect(rows().map((_, i) => part(i, "hide-telop")?.textContent ?? null)).toEqual([null, "字幕に出さない", "字幕に出す"]);
    expect(rows().map((_, i) => part(i, "line-edit-button") !== null)).toEqual([false, true, true]);
  });

  test("区間に入っていてもテロップの無い行 (手で作った区間の中) には、✎ も「字幕に出さない」も出さない", () => {
    const { panel } = setup();
    panel.update(view({ rows: [{ id: "m", startSec: 3, text: "手作りの区間の中", selected: true, hidden: false, hasTelop: false }] }));
    expect(rows()[0]?.dataset.selected).toBe("true");
    expect(part(0, "line-edit-button")).toBeNull();
    expect(part(0, "hide-telop")).toBeNull();
  });

  test("行の並びが同じなら、行の要素を作り直さずに印と文字だけ直す", () => {
    const { panel } = setup();
    panel.update(view());
    const before = rows();
    panel.update(
      view({
        rows: [
          { id: "a", startSec: 1, text: "さあ残り 30 秒", selected: true, hidden: false, hasTelop: true },
          { id: "b", startSec: 65, text: "直した", selected: true, hidden: false, hasTelop: true },
          { id: "c", startSec: 70, text: "えーと", selected: false, hidden: false, hasTelop: false },
        ],
      }),
    );
    rows().forEach((row, i) => expect(row).toBe(before[i]));
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "true", "false"]);
    expect(part(1, "line-text")?.textContent).toBe("直した");
    expect(part(2, "hide-telop")).toBeNull();
  });
});

describe("見出しと案内", () => {
  test("取っている間・字幕が無い・取れなかった、をそれぞれ出す。取れなかったときは取り直せる", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ header: { kind: "loading" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toBe("文字起こしを取っています…");
    panel.update(view({ header: { kind: "none" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toBe("この動画には公式字幕がありません");
    panel.update(view({ header: { kind: "failed", reason: "字幕が空で返りました" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toContain("文字起こしを取れませんでした: 字幕が空で返りました");
    role("transcript-retry")?.click();
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
  });

  test("吹き替えの音声が流れていれば知らせる", () => {
    const { panel } = setup();
    panel.update(view({ dubbed: true }));
    expect(role("transcript-dubbed")?.textContent).toContain("吹き替えの音声が流れています");
    panel.update(view({ dubbed: false }));
    expect(role("transcript-dubbed")).toBeNull();
  });
});

describe("操作", () => {
  test("行を押すと入れる / 外すを伝える。Shift 付きはまとめて", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    rows()[0]?.click();
    part(1, "line-text")?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(callbacks.onToggle).toHaveBeenNthCalledWith(1, "a", false);
    expect(callbacks.onToggle).toHaveBeenNthCalledWith(2, "b", true);
  });

  test("時刻を押すとその行から再生を伝え、行の選択は動かさない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(0, "line-time")?.click();
    expect(callbacks.onPlay).toHaveBeenCalledWith("a");
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("「字幕に出さない」を押すと伝え、行の選択は動かさない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "hide-telop")?.click();
    expect(callbacks.onToggleHidden).toHaveBeenCalledWith("b");
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("✎ で直す欄になり、Enter で確定、Esc で戻す。行の選択は動かさない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    expect(editor()?.value).toBe("ここは絶対に右から");
    editor()!.value = "ここは絶対に右から回るべきだった";
    key(editor()!, { key: "Enter" });
    expect(callbacks.onEditText).toHaveBeenCalledWith("b", "ここは絶対に右から回るべきだった");
    expect(editor()).toBeNull();

    part(1, "line-edit-button")?.click();
    key(editor()!, { key: "Escape" });
    expect(editor()).toBeNull();
    expect(callbacks.onEditText).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("直す欄を押しても、行の入れる / 外すにしない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    editor()?.click();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("IME の変換中の Enter と Esc では、確定も取り消しもしない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    key(editor()!, { key: "Enter", isComposing: true });
    key(editor()!, { key: "Escape", isComposing: true });
    key(editor()!, { key: "Enter", keyCode: 229 });
    expect(callbacks.onEditText).not.toHaveBeenCalled();
    expect(editor()).not.toBeNull();
  });

  test("確定を拒まれたら (長すぎる) 直す欄を閉じない", () => {
    const { panel } = setup({ onEditText: vi.fn(() => false) });
    panel.update(view());
    part(1, "line-edit-button")?.click();
    key(editor()!, { key: "Enter" });
    expect(editor()).not.toBeNull();
  });

  test("直している間に描き直されても、直す欄と書きかけを残す (input が来ていなくても)", () => {
    const { panel } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    editor()!.value = "書きかけ";
    panel.update(view());
    expect(editor()?.value).toBe("書きかけ");
  });

  test("直している行が区間から外れたら、直す欄を閉じる", () => {
    const { panel } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    panel.update(
      view({
        rows: [
          { id: "a", startSec: 1, text: "さあ残り 30 秒", selected: false, hidden: false, hasTelop: false },
          { id: "b", startSec: 65, text: "ここは絶対に右から", selected: false, hidden: false, hasTelop: false },
        ],
      }),
    );
    expect(editor()).toBeNull();
  });

  test("押せない間 (enabled: false) は入れる / 外す・直す・出さないを伝えない。再生は伝える", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ enabled: false }));
    rows()[0]?.click();
    part(1, "hide-telop")?.click();
    part(1, "line-edit-button")?.click();
    part(0, "line-time")?.click();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onToggleHidden).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    expect(callbacks.onPlay).toHaveBeenCalledWith("a");
  });
});

test("setCurrentTime で、再生位置を含む行 (その位置より前で最後に始まる行) に ▶ を付ける", () => {
  const { panel } = setup();
  panel.update(view());
  const marks = (): string[] => rows().map((row) => `${row.dataset.current}:${row.querySelector("[data-role='line-now']")?.textContent ?? ""}`);
  panel.setCurrentTime(66);
  expect(marks()).toEqual(["false:", "true:▶", "false:"]);
  panel.setCurrentTime(0.5);
  expect(marks()).toEqual(["false:", "false:", "false:"]);
  panel.setCurrentTime(100);
  expect(marks()).toEqual(["false:", "false:", "true:▶"]);
});
