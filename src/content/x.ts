import { baseMimeType } from "@/content/codec";
import { X_SELECTORS } from "@/content/selectors";
import { decodeBase64 } from "@/shared/base64";
import type { Message } from "@/shared/messages";

export class SelectorMissingError extends Error {
  constructor(selectors: readonly string[]) {
    super(`X の画面に要素が見つかりません: ${selectors.join(", ")}`);
    this.name = "SelectorMissingError";
  }
}

/** 候補セレクタを順に試し、最初に見つかった要素を返す */
export function findElement<T extends HTMLElement>(
  selectors: readonly string[],
): T {
  for (const selector of selectors) {
    const found = document.querySelector<T>(selector);
    if (found !== null) return found;
  }
  throw new SelectorMissingError(selectors);
}

/**
 * 要素が現れるまで待つ。
 * 投稿画面は非同期に構築されるため即時取得できないことがある。
 * 永久に待たないよう必ずタイムアウトさせる。
 */
export function waitForElement<T extends HTMLElement>(
  selectors: readonly string[],
  timeoutMs = 10000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tryFind = (): T | null => {
      for (const selector of selectors) {
        const found = document.querySelector<T>(selector);
        if (found !== null) return found;
      }
      return null;
    };

    const immediate = tryFind();
    if (immediate !== null) {
      resolve(immediate);
      return;
    }

    const observer = new MutationObserver(() => {
      const found = tryFind();
      if (found !== null) {
        cleanup();
        resolve(found);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new SelectorMissingError(selectors));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      observer.disconnect();
    };

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** input[type=file] にファイルを載せる */
export function attachFile(
  input: HTMLInputElement,
  file: File,
  createDataTransfer: () => DataTransfer = () => new DataTransfer(),
): void {
  const transfer = createDataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  // React 側に変更を伝えるため change を明示的に発火する
  input.dispatchEvent(new Event("change", { bubbles: true }));
}


/**
 * 投稿画面の入力欄に本文を入れる。
 *
 * **paste しか使ってはいけない。** `document.execCommand("insertText")` は
 * Draft.js に対して壊れた入り方をする。実機で測って確かめた内訳:
 *
 * 1. Chromium の `ExecuteInsertText` は `TypingCommand` を直接呼ぶので
 *    `textInput` が出ず、Draft.js の `beforeinput` ハンドラが**一度も走らない**
 * 2. Chromium が改行ごとに挿入を分割し、`input` を複数回発火させる
 * 3. Draft.js は `input` を「スペルチェックの突合」として扱い、キャレットのある
 *    **1 つの leaf だけ**をモデルへ書き戻す。分割で複製された要素は元と同じ
 *    `data-offset-key` を持つため、後続の断片が先頭ブロックを上書きする
 *
 * 結果、**画面には全部入っているのにモデルにはタグだけが繰り返し入る**という
 * 形で壊れた。X が投稿するのはモデル側なので、見えているものは当てにならない。
 *
 * `editOnPaste` は違う。clipboard のテキストを自分で改行分割し、内部の
 * SelectionState を使ってモデルを差し替え、React が描き直す。**DOM を自分で
 * 触らないので、モデルと DOM がずれない。**
 */

/** 貼り付けた結果が画面に出るまで待つ上限 */
const PASTE_RENDER_TIMEOUT_MS = 2000;
/** 選択が Draft.js へ届くまで待つ上限 */
const SELECTION_TIMEOUT_MS = 300;

/**
 * Draft.js が管理しているブロックから、モデルの中身を組み立てる。
 *
 * **`textContent` を見てはいけない。** 壊れた入り方をしたときに残る幽霊 DOM が
 * 混ざり、入っていないものが入って見える
 */
export function readBlocks(editor: HTMLElement): string {
  const blocks = editor.querySelectorAll<HTMLElement>("[data-block]");
  if (blocks.length === 0) return "";
  return Array.from(blocks)
    .map((block) => block.textContent ?? "")
    .join("\n");
}

/** 指定の出来事を待つ。来なければ時間切れで戻る */
function waitFor(
  target: EventTarget,
  type: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      target.removeEventListener(type, done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    target.addEventListener(type, done, { once: true });
  });
}

/** 入力欄の中身を全部選ぶ。Draft.js に選択が届くまで待つ */
async function selectAll(editor: HTMLElement): Promise<void> {
  editor.focus();
  // **focusin を自分で出すこと。** React は focusin で activeElement を追う。
  // ウィンドウが OS のフォーカスを持たないと focus() では出ず、選択が
  // Draft.js へ届かないまま貼り付けが末尾に足される
  editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  // Draft.js は DOM の選択ではなく内部の SelectionState を使う。
  // selectionchange を経由して届くので、それを待つ
  await waitFor(document, "selectionchange", SELECTION_TIMEOUT_MS);
}

/** 貼り付けた結果が画面に出るまで待つ */
function waitForRender(editor: HTMLElement, expected: string): Promise<boolean> {
  if (readBlocks(editor) === expected) return Promise.resolve(true);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (readBlocks(editor) !== expected) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(true);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(readBlocks(editor) === expected);
    }, PASTE_RENDER_TIMEOUT_MS);
    observer.observe(editor, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/** 1 回分の貼り付け。入ったかどうかを返す */
async function pasteOnce(editor: HTMLElement, text: string): Promise<boolean> {
  await selectAll(editor);

  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }),
  );

  return waitForRender(editor, text);
}

export async function insertText(
  editor: HTMLElement,
  text: string,
): Promise<void> {
  // **中身の一致で判定すること。** 先頭だけを見ると、モデルに一部しか
  // 入っていない壊れ方を見逃す
  if (await pasteOnce(editor, text)) {
    console.info(`[yt-clip] 本文を paste で入力しました (${text.length} 文字)`);
    return;
  }

  // 一度だけやり直す。選択が届かず末尾に足された場合はここで直る
  if (await pasteOnce(editor, text)) {
    console.info(
      `[yt-clip] 本文を paste で入力しました (2 回目、${text.length} 文字)`,
    );
    return;
  }

  throw new Error(
    `本文を入力できませんでした (入力欄: ${readBlocks(editor).slice(0, 40)})`,
  );
}


/**
 * service worker へ添付の結果を伝える。
 *
 * 送れなかった場合、service worker は `composing` のまま待ち続ける。
 * 投稿タブにはこの拡張の UI が無く、失敗を伝える相手はコンソールしかない
 * ため、握り潰さず理由を残す (`docs/manual-check.md` の X 添付の節で、
 * 投稿タブのコンソールを見る手順と対になっている)。
 */
/**
 * 添付するファイルを組み立てる。
 *
 * **MIME からパラメータを落とすこと。** X は `File.type` で対応形式を判定し、
 * `video/mp4;codecs="avc1.42E01E,mp4a.40.2"` のようなコーデック付きの値は
 * そのまま `File.type` に残るため、中身が正しい MP4 でも
 * 「一部の画像/動画をアップロードできません。」で弾かれる。
 *
 * 送られてくる時点で service worker が素の MIME にしているが、ここは
 * 相手 (X) がラベルを検証する境界なので、送り手を信用せずここでも落とす。
 */
export function buildClipFile(message: {
  base64: string;
  fileName: string;
  mimeType: string;
}): File {
  return new File([decodeBase64(message.base64)], message.fileName, {
    type: baseMimeType(message.mimeType),
  });
}

function notify(message: Message): void {
  void chrome.runtime.sendMessage(message).catch((error: unknown) => {
    console.error("[yt-clip] 拡張への通知に失敗しました", message.type, error);
  });
}

// content script は常に chrome 拡張コンテキストで読み込まれるため実行時は必ず true になるが、
// 単体テスト (jsdom) は chrome グローバルを持たないため import 時点の副作用が
// ReferenceError で落ちる。テストのために振る舞いを変えるのではなく、
// 拡張コンテキスト外で読み込まれた場合に安全側へ倒すガードとして扱う。
/**
 * 受け取った本文と動画を投稿画面へ載せる。
 *
 * **本文が先、添付が後。** ファイルを添付すると X が UI を作り直すため、
 * その最中に入力すると焦点が定まらない。
 *
 * 投稿ボタンは押さない。最終確認はユーザーに委ねる。
 */
export async function attachPayload(message: {
  base64: string;
  fileName: string;
  mimeType: string;
  text: string;
}): Promise<void> {
  try {
    const editor = await waitForElement<HTMLElement>(X_SELECTORS.editor);
    // insertText が全選択して置き換えるので、前回の下書きはここで消える
    await insertText(editor, message.text);

    const input = await waitForElement<HTMLInputElement>(
      X_SELECTORS.fileInput,
    );
    attachFile(input, buildClipFile(message));

    // 入れ直しの見張りは持たない。「添付で本文が消える」と見えていたのは、
    // execCommand が作った幽霊 DOM が再描画で消えていただけ。paste なら
    // モデルに入るので消えない

    notify({ type: "x/attached" });
  } catch (error) {
    notify({ type: "x/failed", reason: String(error) });
  }
}

if (typeof chrome !== "undefined") {

  /**
   * **同期で `sendResponse()` を返すこと。** 応答しないと送り手の Promise は
   * `The message port closed before a response was received.` で reject し、
   * 受け取って添付を進めていることが「投稿タブが居ない」と区別できなくなる
   * (service worker がダウンロード誘導へ退避してしまう)。
   * `return true` にして添付の完了後に応答するのも不可 — 送り手は直列 queue の
   * 中で待つため、その間 router 全体が止まる。添付の結果は `x/attached` /
   * `x/failed` で別途知らせる。
   */
  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    if (message.type !== "x/payload") return;
    sendResponse();

    void attachPayload(message);
  });

  // 投稿画面が開かれたことを service worker に知らせる
  if (location.pathname.startsWith("/compose/")) {
    notify({ type: "x/ready" });
  }
}
