/**
 * エディットモードで出すテロップの一覧。
 *
 * **選択状態は持たない。** 区間の一覧と違い、拡大バーと連動させない (時刻は
 * 「開始を今に / 終了を今に」で決める)。渡されたものを描き、押されたことを伝えるだけ。
 */

import { TELOP_STYLE } from "@/content/styles";
import { overlapsSegments } from "@/shared/telop";
import { formatTime } from "@/shared/time";
import type { ClipRange, Telop } from "@/shared/types";

export type TelopListCallbacks = {
  /** ＋ テロップ。今の再生位置から足す */
  onAdd(): void;
  onSetStart(index: number): void;
  onSetEnd(index: number): void;
  /** そのテロップの頭から再生する */
  onPlay(index: number): void;
  onRemove(index: number): void;
  /** 文言が確定した (フォーカスが外れた) */
  onText(index: number, text: string): void;
};

export type TelopList = {
  element: HTMLElement;
  /** テロップと区間 (区間外の判定に使う) を反映して描き直す */
  update(telops: Telop[], segments: ClipRange[]): void;
  /** 操作を受け付けるか。ready / posted のときだけ true */
  setEnabled(enabled: boolean): void;
};

type Row = {
  root: HTMLElement;
  label: HTMLElement;
  outside: HTMLElement;
  textarea: HTMLTextAreaElement;
};

function telopLabel(telop: Telop, index: number): string {
  return `${index + 1}. ${formatTime(telop.startSec)} 〜 ${formatTime(telop.endSec)}`;
}

export function createTelopList(callbacks: TelopListCallbacks): TelopList {
  const element = document.createElement("div");
  element.style.cssText = TELOP_STYLE.root;
  element.hidden = true;

  let enabled = true;

  /** 押せない間は伝えない。押せるのに何も起きない状態を作らない */
  function fire(action: () => void): (event: Event) => void {
    return (event) => {
      event.stopPropagation();
      if (!enabled) return;
      action();
    };
  }

  function makeButton(
    role: string,
    label: string,
    title: string,
    style: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.role = role;
    button.textContent = label;
    button.title = title;
    button.style.cssText = style;
    button.addEventListener("click", fire(onClick));
    return button;
  }

  const header = document.createElement("div");
  header.style.cssText = TELOP_STYLE.header;
  const title = document.createElement("span");
  title.style.cssText = TELOP_STYLE.title;
  title.textContent = "テロップ";
  header.append(
    title,
    makeButton("add-telop", "＋ テロップ", "今の位置からテロップを足す", TELOP_STYLE.textButton, () =>
      callbacks.onAdd(),
    ),
  );

  const body = document.createElement("div");
  body.style.cssText = TELOP_STYLE.root;
  element.append(header, body);

  /**
   * 行は index ごとに使い回す。**作り直さない。** 状態通知のたびに作り直すと、
   * 打ちかけの文字とフォーカスが消える
   */
  const rows: Row[] = [];

  function makeRow(index: number): Row {
    const root = document.createElement("div");
    root.dataset.role = "telop";
    root.style.cssText = TELOP_STYLE.row;

    const head = document.createElement("div");
    head.style.cssText = TELOP_STYLE.rowHead;
    const label = document.createElement("span");
    label.style.cssText = TELOP_STYLE.label;
    const outside = document.createElement("span");
    outside.style.cssText = TELOP_STYLE.outside;

    head.append(
      label,
      outside,
      makeButton("set-start", "開始を今に", "開始を今の再生位置に合わせる", TELOP_STYLE.textButton, () =>
        callbacks.onSetStart(index),
      ),
      makeButton("set-end", "終了を今に", "終了を今の再生位置に合わせる", TELOP_STYLE.textButton, () =>
        callbacks.onSetEnd(index),
      ),
      makeButton("play", "▶", "このテロップの頭から再生", TELOP_STYLE.iconButton, () =>
        callbacks.onPlay(index),
      ),
      makeButton("remove", "✕", "このテロップを消す", TELOP_STYLE.iconButton, () =>
        callbacks.onRemove(index),
      ),
    );

    const textarea = document.createElement("textarea");
    textarea.style.cssText = TELOP_STYLE.textarea;
    textarea.placeholder = "文言 (改行できます)";
    // 1 文字ごとに送ると、そのたびにクリップが外れて状態通知が飛ぶ
    textarea.addEventListener("change", () => {
      if (!enabled) return;
      callbacks.onText(index, textarea.value);
    });
    // YouTube のショートカットは入力欄の中では効かない作りだが、**念のため止める。**
    // 打つ文字が多く、YouTube 側の判定が変わったときの被害が大きい
    textarea.addEventListener("keydown", (event) => event.stopPropagation());

    root.append(head, textarea);
    return { root, label, outside, textarea };
  }

  return {
    element,

    update(telops, segments): void {
      // 区間が無いときは箱ごと消す (テロップは区間に焼き込むもの)
      element.hidden = segments.length === 0;

      while (rows.length > telops.length) {
        rows.pop()?.root.remove();
      }
      while (rows.length < telops.length) {
        const row = makeRow(rows.length);
        rows.push(row);
        body.append(row.root);
      }

      telops.forEach((telop, index) => {
        const row = rows[index];
        if (row === undefined) return;
        row.label.textContent = telopLabel(telop, index);
        // **`hidden` は使わない。** textContent には隠れた要素の文字も残るため、
        // 「区間外なら textContent に (区間外) が無い」という見た目の判定と食い違う
        row.outside.textContent = overlapsSegments(telop, segments)
          ? ""
          : "(区間外)";
        // **フォーカス中の入力欄は value も触らない。** 書き換えると打ちかけの
        // 文字が消え、しかもその後 blur しても change が発火しない
        if (document.activeElement !== row.textarea) {
          row.textarea.value = telop.text;
        }
      });
    },

    setEnabled(next): void {
      enabled = next;
      // 見た目でも押せないことを示す。押せる見た目のまま無反応にしない
      element.style.opacity = next ? "1" : "0.5";
      for (const row of rows) row.textarea.disabled = !next;
    },
  };
}
