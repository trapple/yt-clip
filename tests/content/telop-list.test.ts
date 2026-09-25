// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { createTelopList, type TelopListCallbacks } from "@/content/telop-list";
import type { ClipRange, Telop } from "@/shared/types";

const SEGMENTS: ClipRange[] = [{ startSec: 10, endSec: 20 }];
const HELLO: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };
const OUTSIDE: Telop = { startSec: 40, endSec: 43, text: "外" };

function makeCallbacks() {
  const calls: string[] = [];
  const callbacks: TelopListCallbacks = {
    onAdd: () => calls.push("add"),
    onSetStart: (i) => calls.push(`start:${i}`),
    onSetEnd: (i) => calls.push(`end:${i}`),
    onPlay: (i) => calls.push(`play:${i}`),
    onRemove: (i) => calls.push(`remove:${i}`),
    onText: (i, text) => {
      calls.push(`text:${i}:${text}`);
      return true;
    },
  };
  return { calls, callbacks };
}

function rows(list: { element: HTMLElement }): HTMLElement[] {
  return [...list.element.querySelectorAll<HTMLElement>("[data-role=telop]")];
}

function button(row: HTMLElement, role: string): HTMLButtonElement {
  const found = row.querySelector<HTMLButtonElement>(`[data-role=${role}]`);
  if (found === null) throw new Error(`ボタンがありません: ${role}`);
  return found;
}

describe("createTelopList", () => {
  test("区間が無ければ箱ごと隠す", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([], []);
    expect(list.element.hidden).toBe(true);
  });

  test("隠すときは inline の display も none にする", () => {
    // 根は display:flex を inline で持つので、hidden だけだと UA の [hidden] に勝って出たままになる。
    // jsdom は UA の [hidden] を計算しないので style.display で測る
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([], []);
    expect(list.element.style.display).toBe("none");
    list.update([], SEGMENTS);
    expect(list.element.style.display).toBe("flex");
    list.update([], []);
    expect(list.element.style.display).toBe("none");
  });

  test("区間があればテロップが無くても出す (＋ テロップを押せるように)", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([], SEGMENTS);
    expect(list.element.hidden).toBe(false);
    expect(list.element.querySelector("[data-role=add-telop]")).not.toBeNull();
  });

  test("行に時刻と文言を出す", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    const [row] = rows(list);
    expect(row?.textContent).toContain("0:11 〜 0:14");
    expect(row?.querySelector("textarea")?.value).toBe("こんにちは");
  });

  test("どの区間にも重ならなければ (区間外) と出す", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO, OUTSIDE], SEGMENTS);
    const [inside, outside] = rows(list);
    expect(inside?.textContent).not.toContain("区間外");
    expect(outside?.textContent).toContain("(区間外)");
  });

  test("ボタンは index 付きで伝える", () => {
    const { calls, callbacks } = makeCallbacks();
    const list = createTelopList(callbacks);
    list.update([HELLO, OUTSIDE], SEGMENTS);
    const second = rows(list)[1];
    if (second === undefined) throw new Error("行がありません");
    button(second, "set-start").click();
    button(second, "set-end").click();
    button(second, "play").click();
    button(second, "remove").click();
    (list.element.querySelector("[data-role=add-telop]") as HTMLButtonElement).click();
    expect(calls).toEqual(["start:1", "end:1", "play:1", "remove:1", "add"]);
  });

  test("文言はフォーカスが外れたとき (change) に伝える", () => {
    // 1 文字ごとに送ると、そのたびにクリップが外れて状態通知が飛ぶ
    const { calls, callbacks } = makeCallbacks();
    const list = createTelopList(callbacks);
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.value = "やあ";
    textarea.dispatchEvent(new Event("input"));
    expect(calls).toEqual([]);
    textarea.dispatchEvent(new Event("change"));
    expect(calls).toEqual(["text:0:やあ"]);
  });

  test("描き直しても、フォーカス中の入力欄は要素も value も触らない", () => {
    // value を書き換えると打ちかけの文字が消え、その後 blur しても change も発火しなくなる
    const list = createTelopList(makeCallbacks().callbacks);
    document.body.append(list.element);
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.focus();
    textarea.value = "打ちかけ";

    list.update([{ ...HELLO, startSec: 12 }], SEGMENTS);

    const after = rows(list)[0]?.querySelector("textarea");
    expect(after).toBe(textarea);
    expect(after?.value).toBe("打ちかけ");
    // 表示 (時刻) は更新される
    expect(rows(list)[0]?.textContent).toContain("0:12");
    list.element.remove();
  });

  test("送らなかった (onText が false) 入力欄は、フォーカスが無くても次の描き直しで上書きしない", () => {
    // 上限を超えた文言は youtube.ts が理由を出して送らない。前の文言に戻すと打った文字が黙って消える
    const { callbacks } = makeCallbacks();
    const list = createTelopList({ ...callbacks, onText: () => false });
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.value = "長すぎる下書き";
    textarea.dispatchEvent(new Event("change"));

    list.update([{ ...HELLO, startSec: 12 }], SEGMENTS);

    expect(textarea.value).toBe("長すぎる下書き");
  });

  test("送らなかった下書きも、状態の側で文言が変わったら状態に合わせる", () => {
    // 別の経路で書き換えられた・前の行が消えて別のテロップの行になった
    const { callbacks } = makeCallbacks();
    const list = createTelopList({ ...callbacks, onText: () => false });
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.value = "長すぎる下書き";
    textarea.dispatchEvent(new Event("change"));

    list.update([OUTSIDE], SEGMENTS);

    expect(textarea.value).toBe("外");
  });

  test("送れたら (onText が true) 次の描き直しは状態の値に合わせる", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.value = "送った";
    textarea.dispatchEvent(new Event("change"));

    // 状態機械が受けた文言で戻ってくる前の通知 (まだ前の文言) でも、下書きとしては持たない
    list.update([HELLO], SEGMENTS);

    expect(textarea.value).toBe("こんにちは");
  });

  test("フォーカスしていない入力欄は状態の値に合わせる", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    list.update([{ ...HELLO, text: "別のタブで変えた" }], SEGMENTS);
    expect(rows(list)[0]?.querySelector("textarea")?.value).toBe("別のタブで変えた");
  });

  test("数が減れば行も減る", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO, OUTSIDE], SEGMENTS);
    list.update([HELLO], SEGMENTS);
    expect(rows(list)).toHaveLength(1);
  });

  test("入力欄の keydown は YouTube のショートカットへ伝えない", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    const outer = vi.fn();
    document.body.append(list.element);
    document.body.addEventListener("keydown", outer);
    rows(list)[0]
      ?.querySelector("textarea")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", outer);
    list.element.remove();
  });

  test("無効な間は押しても伝えない", () => {
    const { calls, callbacks } = makeCallbacks();
    const list = createTelopList(callbacks);
    list.update([HELLO], SEGMENTS);
    list.setEnabled(false);
    const row = rows(list)[0];
    if (row === undefined) throw new Error("行がありません");
    button(row, "remove").click();
    expect(calls).toEqual([]);
  });

  test("無効な間に作った行の入力欄も無効", () => {
    // setEnabled(false) → update の順で呼ばれると (content script の読み直し
    // 直後の preview / 録画中など)、この時点で初めて作られる行がある。
    // 見た目だけ薄くして中身は押せるままにしない
    const list = createTelopList(makeCallbacks().callbacks);
    list.setEnabled(false);
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    expect(textarea?.disabled).toBe(true);
  });
});
