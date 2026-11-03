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
    onSelectSegment: vi.fn(),
    onRemoveSegment: vi.fn(),
    onAddManual: vi.fn(),
    onManualEdge: vi.fn(),
    onManualText: vi.fn(() => true),
    onRemoveManual: vi.fn(),
    onPlayManual: vi.fn(),
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
  items: [],
  trimmingIndex: -1,
  canAddManual: false,
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
    expect(role("transcript-notice")?.textContent).toBe("この動画には公式字幕がありません。IN / OUT で区間を作り、＋ ここに字幕を足す でテロップを足せます");
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

describe("区間の見出しと手入力の行 (段階 1c-2)", () => {
  const SEGMENT = { kind: "segment", index: 0, startSec: 64.8, endSec: 73.3, before: 1 } as const;
  const MANUAL = { kind: "manual", telopIndex: 2, startSec: 66, endSec: 69, text: "ここ重要", inSegment: true, fromLine: false, before: 2 } as const;
  const listChildren = (): string[] =>
    [...(role("transcript-lines")?.children ?? [])].map((child) => {
      const el = child as HTMLElement;
      return el.dataset.role === "line" ? `line:${el.dataset.lineId}` : `${el.dataset.role}`;
    });
  const header = (): HTMLElement => document.querySelector<HTMLElement>("[data-role='segment']")!;
  const manual = (): HTMLElement => document.querySelector<HTMLElement>("[data-role='telop']")!;
  const inManual = (name: string): HTMLElement | null => manual().querySelector<HTMLElement>(`[data-role='${name}']`);

  test("見出しと手入力の行は、指した行の前に入る", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    expect(listChildren()).toEqual(["line:a", "segment", "line:b", "telop", "line:c"]);
  });

  test("行の数を指すものは末尾に入る。行が無くても並ぶ (字幕の無い動画)", () => {
    const { panel } = setup();
    panel.update(view({ header: { kind: "none" }, rows: [], items: [{ ...SEGMENT, before: 0 }, { ...MANUAL, before: 0 }] }));
    expect(listChildren()).toEqual(["segment", "telop"]);
  });

  test("見出しに区間の番号・頭と尻・長さを出し、詰めている区間には「· 詰めている」", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT], trimmingIndex: -1 }));
    expect(header().querySelector("[data-role='segment-title']")?.textContent).toBe("区間 1");
    expect(header().querySelector("[data-role='segment-range']")?.textContent).toBe("1:04.80 – 1:13.30 · 8.5 秒");
    expect(header().dataset.selected).toBe("false");

    panel.update(view({ items: [SEGMENT], trimmingIndex: 0 }));
    expect(header().querySelector("[data-role='segment-title']")?.textContent).toBe("区間 1 · 詰めている");
    expect(header().dataset.selected).toBe("true");
  });

  test("見出しを押すと選び、✕ で消す (✕ は選ばない)", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [SEGMENT] }));
    header().click();
    expect(callbacks.onSelectSegment).toHaveBeenCalledWith(0);
    header().querySelector<HTMLElement>("[data-role='remove']")!.click();
    expect(callbacks.onRemoveSegment).toHaveBeenCalledWith(0);
    expect(callbacks.onSelectSegment).toHaveBeenCalledTimes(1);
    // 見出しを押しても行の入れ外しにはならない
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("手入力の行は時刻と文字を出し、空の文字は「まだ書いていません」", () => {
    const { panel } = setup();
    panel.update(view({ items: [MANUAL] }));
    expect(manual().dataset.telopIndex).toBe("2");
    expect(inManual("manual-time")?.textContent).toBe("1:06");
    expect(inManual("manual-text")?.textContent).toBe("ここ重要");
    expect(inManual("manual-text")?.dataset.empty).toBe("false");

    panel.update(view({ items: [{ ...MANUAL, text: "" }] }));
    expect(inManual("manual-text")?.textContent).toBe("（まだ書いていません）");
    expect(inManual("manual-text")?.dataset.empty).toBe("true");

    // 区間から外れた、字幕に出さないにした行のテロップ。書いていないのとは違う
    panel.update(view({ items: [{ ...MANUAL, text: "", fromLine: true }] }));
    expect(inManual("manual-text")?.textContent).toBe("（字幕に出さない行）");
  });

  test("手入力の行の文字はタグとして解釈しない", () => {
    const { panel } = setup();
    panel.update(view({ items: [{ ...MANUAL, text: "<img src=x onerror=alert(1)>" }] }));
    expect(document.querySelector("img")).toBeNull();
  });

  test("区間の外の手入力の行には「(区間外)」が付く", () => {
    const { panel } = setup();
    panel.update(view({ items: [{ ...MANUAL, inSegment: false }] }));
    expect(manual().dataset.inSegment).toBe("false");
    expect(inManual("telop-outside")?.textContent).toBe("(区間外)");
    panel.update(view({ items: [MANUAL] }));
    expect(inManual("telop-outside")).toBeNull();
  });

  test("頭を今に・尻を今に・✕・時刻を押すと、テロップの位置で伝える", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("set-start")!.click();
    inManual("set-end")!.click();
    inManual("manual-time")!.click();
    inManual("remove")!.click();
    expect(callbacks.onManualEdge).toHaveBeenNthCalledWith(1, 2, "start");
    expect(callbacks.onManualEdge).toHaveBeenNthCalledWith(2, 2, "end");
    expect(callbacks.onPlayManual).toHaveBeenCalledWith(2);
    expect(callbacks.onRemoveManual).toHaveBeenCalledWith(2);
  });

  test("押せない間 (録画中など) は手入力の行を変えないが、時刻からの再生は伝える", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [MANUAL], enabled: false }));
    inManual("set-start")!.click();
    inManual("remove")!.click();
    inManual("manual-edit-button")!.click();
    inManual("manual-time")!.click();
    expect(callbacks.onManualEdge).not.toHaveBeenCalled();
    expect(callbacks.onRemoveManual).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    expect(callbacks.onPlayManual).toHaveBeenCalledWith(2);
  });

  test("✎ で直す欄が開き、Enter でテロップの位置と文字を伝えて閉じる", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    expect(editor()?.value).toBe("ここ重要");
    editor()!.value = "ここ大事";
    key(editor()!, { key: "Enter" });
    expect(callbacks.onManualText).toHaveBeenCalledWith(2, "ここ大事");
    expect(editor()).toBeNull();
  });

  test("送らなかった (上限を超えた) ときは直す欄を閉じない", () => {
    const { panel } = setup({ onManualText: vi.fn(() => false) });
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    editor()!.value = "あ".repeat(501);
    key(editor()!, { key: "Enter" });
    expect(editor()?.value).toBe("あ".repeat(501));
  });

  test("直している間に状態が届いても、書きかけとフォーカスを残す", () => {
    const { panel } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    editor()!.value = "書きかけ";
    // ほかの操作 (別の行の入れ外し) の答え。手入力の行の並びは同じ
    panel.update(view({ items: [MANUAL], trimmingIndex: 0 }));
    expect(editor()?.value).toBe("書きかけ");
    expect(document.activeElement).toBe(editor());
  });

  test("手入力の行の数が変わったら直す欄を閉じる (位置がずれて別のテロップに書き込まない)", () => {
    const { panel } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    panel.update(view({ items: [{ ...MANUAL, telopIndex: 1, startSec: 60 }, MANUAL] }));
    expect(editor()).toBeNull();
  });

  test("数が同じでも位置が詰まったら閉じる (前の字幕の行を外して、行のテロップが消えたとき)", () => {
    // テロップが [行 L0, 手 M1, 手 M2] のとき M1 を直し始め、L0 の行を外すと [M1 (0), M2 (1)] になる。
    // manual:1 はまだあり数も 2 のままだが、閉じないと Enter で M2 を上書きする
    const { panel } = setup();
    const m1 = { ...MANUAL, telopIndex: 1, startSec: 66 };
    const m2 = { ...MANUAL, telopIndex: 2, startSec: 68, text: "二つ目" };
    panel.update(view({ items: [m1, m2] }));
    document.querySelector<HTMLElement>("[data-telop-index='1'] [data-role='manual-edit-button']")!.click();
    expect(editor()).not.toBeNull();
    panel.update(view({ items: [{ ...m1, telopIndex: 0 }, { ...m2, telopIndex: 1 }] }));
    expect(editor()).toBeNull();
  });

  test("editManual で直す欄を開く (足した直後)", () => {
    const { panel } = setup();
    panel.update(view({ items: [{ ...MANUAL, text: "" }] }));
    panel.editManual(2);
    expect(editor()?.value).toBe("");
    expect(document.activeElement).toBe(editor());
  });

  test("「＋ ここに字幕を足す」は区間があって押せるときだけ押せる", () => {
    const { panel, callbacks } = setup();
    const add = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-role='add-telop']")!;
    panel.update(view({ canAddManual: false }));
    expect(add().textContent).toBe("＋ ここに字幕を足す");
    expect(add().disabled).toBe(true);
    expect(add().title).toBe("先に区間を作ってください (行を押す・IN / OUT・＋ 区間を追加)");

    panel.update(view({ canAddManual: true, enabled: false }));
    expect(add().disabled).toBe(true);

    panel.update(view({ canAddManual: true }));
    expect(add().disabled).toBe(false);
    add().click();
    expect(callbacks.onAddManual).toHaveBeenCalledTimes(1);
  });

  test("字幕の無い動画の案内は、区間を作ってから足す道を出す", () => {
    const { panel } = setup();
    panel.update(view({ header: { kind: "none" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toBe(
      "この動画には公式字幕がありません。IN / OUT で区間を作り、＋ ここに字幕を足す でテロップを足せます",
    );
  });

  test("reveal は差し込んだ要素を返し、欄の中をそこまで送る", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    expect(panel.reveal({ kind: "segment", index: 0 })).toBe(header());
    expect(panel.reveal({ kind: "manual", telopIndex: 2 })).toBe(manual());
    expect(panel.reveal({ kind: "manual", telopIndex: 9 })).toBeNull();
  });

  test("差し込むものが同じなら作り直さない", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    const before = header();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    expect(header()).toBe(before);
  });
});
