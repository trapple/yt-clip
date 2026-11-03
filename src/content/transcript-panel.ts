import { TRANSCRIPT_STYLE } from "@/content/styles";
import { formatTime } from "@/shared/time";

/**
 * 文字起こしの欄 (ADR 0001)。区間・テロップの窓の先頭に出す。
 *
 * **選択は持たない。** 行が区間に入っているかは状態機械の区間から決まり、youtube.ts が計算して渡す
 * (区間の一覧と同じ作法)。この欄は渡された行を描き、押されたことを伝えるだけ。
 * **文字は textContent でだけ入れる** (字幕の文字はページから届く。タグとして解釈しない)。
 * **行の要素は、行の並びが変わったときだけ作り直す** (長い配信では 8000 行ほどになる。状態が届くたびに全部を
 * 作り直すと止まって見える)。それ以外は、変わった行の印と文字だけを直す
 */

export type TranscriptRow = {
  id: string;
  startSec: number;
  /** 出す文字。区間に入っていて直した行は、直した文字 */
  text: string;
  /** 区間に入っている */
  selected: boolean;
  /** 区間に入っているが、テロップには出さない */
  hidden: boolean;
  /**
   * この行から作ったテロップがある。✎ と「字幕に出さない」はこれがあるときだけ出す
   * (手で作った区間の中の行は、区間に入っていてもテロップが無い。押しても何も起きないボタンを出さない)
   */
  hasTelop: boolean;
};

export type TranscriptHeader =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; label: string };

export type TranscriptView = {
  header: TranscriptHeader;
  dubbed: boolean;
  rows: TranscriptRow[];
  /** 入れる / 外す・直す・出さないを受け付けるか (録画中・録画した後は false)。再生は欄では止めない (youtube.ts が見る) */
  enabled: boolean;
};

export type TranscriptPanelCallbacks = {
  onToggle(id: string, extend: boolean): void;
  /** 文字の確定。送らなかったら false (直す欄を閉じない) */
  onEditText(id: string, text: string): boolean;
  onToggleHidden(id: string): void;
  onPlay(id: string): void;
  onRetry(): void;
};

export type TranscriptPanel = {
  element: HTMLElement;
  update(view: TranscriptView): void;
  /** 再生位置。毎フレーム呼ばれる: 印を付け替えるのは、印を付ける行が変わったときだけ */
  setCurrentTime(sec: number): void;
};

/** 手でスクロールした後、自動で追わない時間 (ミリ秒) */
const FOLLOW_PAUSE_MS = 5000;

const DUBBED_TEXT =
  "吹き替えの音声が流れています。字幕は元の音声のものなので、録画の音と合わないことがあります";

/** 行 1 つ分の要素。描いた中身 (`row`) を覚えておき、変わったところだけ直す */
type RowParts = {
  element: HTMLElement;
  now: HTMLElement;
  time: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  row: TranscriptRow | null;
};

function sameIds(parts: RowParts[], rows: TranscriptRow[]): boolean {
  return parts.length === rows.length && rows.every((row, i) => parts[i]?.element.dataset.lineId === row.id);
}

export function createTranscriptPanel(callbacks: TranscriptPanelCallbacks): TranscriptPanel {
  const element = document.createElement("div");
  element.dataset.role = "transcript";
  element.style.cssText = TRANSCRIPT_STYLE.root;

  const header = document.createElement("div");
  header.style.cssText = TRANSCRIPT_STYLE.header;
  const title = document.createElement("span");
  title.style.cssText = TRANSCRIPT_STYLE.title;
  title.textContent = "文字起こし";
  const source = document.createElement("span");
  source.dataset.role = "transcript-source";
  source.style.cssText = TRANSCRIPT_STYLE.source;
  header.append(title, source);

  const notice = document.createElement("div");
  notice.dataset.role = "transcript-notice";
  notice.style.cssText = TRANSCRIPT_STYLE.notice;

  const dubbedBox = document.createElement("div");
  const list = document.createElement("div");
  list.dataset.role = "transcript-lines";
  list.style.cssText = TRANSCRIPT_STYLE.lines;

  element.append(header, notice, dubbedBox, list);

  let view: TranscriptView = { header: { kind: "loading" }, dubbed: false, rows: [], enabled: true };
  /** 直している行と書きかけ。描き直しても残す */
  let editing: { id: string; draft: string } | null = null;
  let editor: HTMLTextAreaElement | null = null;
  let currentIndex = -1;
  let parts: RowParts[] = [];
  let userScrolledAt = Number.NEGATIVE_INFINITY;
  let scrollingByUs = false;

  list.addEventListener("scroll", () => {
    if (scrollingByUs) {
      scrollingByUs = false;
      return;
    }
    userScrolledAt = Date.now();
  });

  // 押されたものは行の箱 1 か所で受ける (8000 行に 1 つずつリスナーを付けない)
  list.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-role='line-edit']") !== null) return;
    const rowElement = target.closest<HTMLElement>("[data-role='line']");
    const id = rowElement?.dataset.lineId;
    if (id === undefined) return;
    const action = target.closest<HTMLElement>(
      "[data-role='line-time'], [data-role='hide-telop'], [data-role='line-edit-button']",
    )?.dataset.role;
    if (action === "line-time") {
      callbacks.onPlay(id);
      return;
    }
    if (!view.enabled) return;
    if (action === "hide-telop") callbacks.onToggleHidden(id);
    else if (action === "line-edit-button") startEdit(id);
    else callbacks.onToggle(id, event.shiftKey);
  });

  function renderHeader(): void {
    const h = view.header;
    source.textContent = h.kind === "ready" ? h.label : "";
    notice.replaceChildren();
    notice.hidden = h.kind === "ready";
    if (h.kind === "loading") notice.textContent = "文字起こしを取っています…";
    if (h.kind === "none") notice.textContent = "この動画には公式字幕がありません";
    if (h.kind === "failed") {
      const reason = document.createElement("span");
      reason.textContent = `文字起こしを取れませんでした: ${h.reason}`;
      const retry = document.createElement("button");
      retry.dataset.role = "transcript-retry";
      retry.textContent = "もう一度取る";
      retry.style.cssText = TRANSCRIPT_STYLE.textButton;
      retry.addEventListener("click", () => callbacks.onRetry());
      notice.append(reason, retry);
    }
    dubbedBox.replaceChildren();
    if (view.dubbed) {
      const box = document.createElement("div");
      box.dataset.role = "transcript-dubbed";
      box.style.cssText = TRANSCRIPT_STYLE.dubbed;
      box.textContent = DUBBED_TEXT;
      dubbedBox.append(box);
    }
  }

  function makeButton(role: string, label: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.role = role;
    button.textContent = label;
    button.title = title;
    button.style.cssText = TRANSCRIPT_STYLE.textButton;
    return button;
  }

  function makeEditor(id: string): HTMLTextAreaElement {
    const edit = document.createElement("textarea");
    edit.dataset.role = "line-edit";
    edit.style.cssText = TRANSCRIPT_STYLE.edit;
    edit.value = editing?.id === id ? editing.draft : "";
    edit.addEventListener("input", () => {
      if (editing !== null) editing.draft = edit.value;
    });
    edit.addEventListener("keydown", (event) => {
      // ページのショートカット (YouTube の k / j など) に流さない
      event.stopPropagation();
      // IME の変換を確かめる Enter / 取り消す Esc は、直す欄のものではない
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finishEdit(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finishEdit(false);
      }
    });
    return edit;
  }

  function startEdit(id: string): void {
    const row = view.rows.find((item) => item.id === id);
    if (row === undefined || !row.selected || !row.hasTelop) return;
    editing = { id, draft: row.text };
    patchRows();
    editor?.focus();
  }

  function finishEdit(commit: boolean): void {
    if (editing === null) return;
    if (editor !== null) editing.draft = editor.value;
    if (commit && !callbacks.onEditText(editing.id, editing.draft)) return;
    editing = null;
    patchRows();
  }

  function buildRow(): RowParts {
    const rowElement = document.createElement("div");
    rowElement.dataset.role = "line";
    const now = document.createElement("span");
    now.dataset.role = "line-now";
    now.style.cssText = TRANSCRIPT_STYLE.now;
    const time = document.createElement("button");
    time.dataset.role = "line-time";
    time.title = "この行から再生";
    const body = document.createElement("span");
    const actions = document.createElement("span");
    actions.style.cssText = TRANSCRIPT_STYLE.actions;
    rowElement.append(now, time, body, actions);
    return { element: rowElement, now, time, body, actions, row: null };
  }

  function paintCurrent(part: RowParts, current: boolean): void {
    part.element.dataset.current = current ? "true" : "false";
    part.now.textContent = current ? "▶" : "";
    part.time.style.cssText = current ? TRANSCRIPT_STYLE.timeCurrent : TRANSCRIPT_STYLE.time;
  }

  /** 1 行を描く。前に描いた中身と同じ (直す欄の出し入れも無い) なら何もしない */
  function paintRow(part: RowParts, row: TranscriptRow): void {
    const before = part.row;
    const isEditing = editing?.id === row.id;
    const wasEditing = part.body.dataset.role === "line-edit";
    if (
      before !== null &&
      before.selected === row.selected &&
      before.hidden === row.hidden &&
      before.text === row.text &&
      before.hasTelop === row.hasTelop &&
      isEditing === wasEditing
    ) {
      if (isEditing) editor = part.body as HTMLTextAreaElement;
      return;
    }
    part.row = row;
    part.element.dataset.lineId = row.id;
    part.element.dataset.selected = row.selected ? "true" : "false";
    part.element.dataset.hidden = row.hidden ? "true" : "false";
    part.element.style.cssText = row.selected ? TRANSCRIPT_STYLE.rowSelected : TRANSCRIPT_STYLE.row;
    if (before === null || before.startSec !== row.startSec) part.time.textContent = formatTime(row.startSec);

    if (isEditing) {
      if (!wasEditing) {
        const edit = makeEditor(row.id);
        part.body.replaceWith(edit);
        part.body = edit;
      }
      editor = part.body as HTMLTextAreaElement;
    } else {
      if (wasEditing) {
        const span = document.createElement("span");
        part.body.replaceWith(span);
        part.body = span;
      }
      part.body.dataset.role = "line-text";
      part.body.textContent = row.text;
      part.body.style.cssText = row.hidden ? TRANSCRIPT_STYLE.textHidden : TRANSCRIPT_STYLE.text;
    }

    part.actions.replaceChildren();
    if (row.selected && row.hasTelop) {
      part.actions.append(
        makeButton("line-edit-button", "✎", "テロップの文字を直す"),
        makeButton("hide-telop", row.hidden ? "字幕に出す" : "字幕に出さない", "区間に残したまま、テロップだけ出さない / 出す"),
      );
    }
  }

  /** 行の並び (id の列) が変わったときだけ作り直す。ほかは paintRow が変わった行だけを直す */
  function patchRows(): void {
    if (!sameIds(parts, view.rows)) {
      parts = view.rows.map(() => buildRow());
      list.replaceChildren(...parts.map((part) => part.element));
      for (const part of parts) paintCurrent(part, false);
      currentIndex = -1;
    }
    editor = null;
    view.rows.forEach((row, i) => paintRow(parts[i]!, row));
  }

  /** 行の箱の中だけをスクロールして、今の行を見える所に入れる (scrollIntoView はページまで動かす) */
  function follow(): void {
    const row = parts[currentIndex]?.element;
    if (row === undefined || Date.now() - userScrolledAt < FOLLOW_PAUSE_MS) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
    const before = list.scrollTop;
    list.scrollTop = Math.max(0, top - list.clientHeight / 3);
    // 端まで行っていて値が変わらないと scroll が来ない。旗を立てたままだと、次の手のスクロールを見落とす
    if (list.scrollTop !== before) scrollingByUs = true;
  }

  return {
    element,
    update(next): void {
      // 書きかけは input を待たずに取り込む (IME の途中や、input が来ないまま描き直されたとき)
      if (editing !== null && editor !== null) editing.draft = editor.value;
      view = next;
      // 直している行が区間から外れたら、直す欄を閉じる
      if (editing !== null && !next.rows.some((row) => row.id === editing?.id && row.selected && row.hasTelop)) editing = null;
      element.style.opacity = next.enabled ? "1" : "0.5";
      renderHeader();
      patchRows();
    },
    setCurrentTime(sec): void {
      // 行は開始の早い順。sec より前で最後に始まる行
      let low = 0;
      let high = view.rows.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (view.rows[mid]!.startSec <= sec) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (found === currentIndex) return;
      const previous = parts[currentIndex];
      if (previous !== undefined) paintCurrent(previous, false);
      currentIndex = found;
      const now = parts[currentIndex];
      if (now !== undefined) {
        paintCurrent(now, true);
        follow();
      }
    },
  };
}
