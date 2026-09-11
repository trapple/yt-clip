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

/** paste が反映されるのを待つ時間 (ミリ秒) */
const PASTE_SETTLE_MS = 100;

/** 一致を確かめるために見る先頭の文字数 */
const HEAD_LENGTH = 20;

/**
 * 入力された本文に、渡したテキストの先頭が現れているかを見る。
 *
 * 改行を落としてから比べる。Draft.js は貼り付けたテキストの改行を
 * ブロック要素の境目として表し、テキストノードには改行文字を置かない。
 * そのため本文が正しく入っていても `textContent` に改行は現れず、
 * 改行を含んだまま比較すると必ず一致しない。本文テンプレートは
 * 「タイトル + 空行 + URL」なので、タイトルが短いと先頭 20 文字に
 * 改行が入り、成功しているのに失敗と判定してしまう。
 */
function containsHead(actual: string, expected: string): boolean {
  const withoutBreaks = (value: string): string =>
    value.replace(/[\r\n]/g, "");
  return withoutBreaks(actual).includes(
    withoutBreaks(expected).slice(0, HEAD_LENGTH),
  );
}

/**
 * 本文を入力する。contenteditable への代入では React の state に反映されない。
 *
 * 実機で execCommand が false を返して失敗したことがある。ページの
 * コンテキストでは同じコードが成功するため、原因は content script の
 * 実行環境かタイミングにあるが断定できていない。そのため対策を重ねている。
 */
export async function insertText(
  editor: HTMLElement,
  text: string,
): Promise<void> {
  editor.focus();

  // focus だけでは選択範囲が要素内に入らないことがあり、
  // その場合 execCommand は対象を見つけられずに false を返す
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  if (document.execCommand("insertText", false, text)) {
    console.info("[yt-clip] 本文を execCommand で入力しました");
    return;
  }

  // Draft.js はペーストを自前で処理するので、そちらに乗せる
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS));

  // 入ったかどうかは戻り値では判断できない (preventDefault の有無しか分からない)。
  // 実際に本文へ現れたかを見る
  if (containsHead(editor.textContent ?? "", text)) {
    console.info("[yt-clip] 本文を paste で入力しました");
    return;
  }

  throw new Error("本文を入力できませんでした");
}

/**
 * service worker へ添付の結果を伝える。
 *
 * 送れなかった場合、service worker は `composing` のまま待ち続ける。
 * 投稿タブにはこの拡張の UI が無く、失敗を伝える相手はコンソールしかない
 * ため、握り潰さず理由を残す (`docs/manual-check.md` の X 添付の節で、
 * 投稿タブのコンソールを見る手順と対になっている)。
 */
function notify(message: Message): void {
  void chrome.runtime.sendMessage(message).catch((error: unknown) => {
    console.error("[yt-clip] 拡張への通知に失敗しました", message.type, error);
  });
}

// content script は常に chrome 拡張コンテキストで読み込まれるため実行時は必ず true になるが、
// 単体テスト (jsdom) は chrome グローバルを持たないため import 時点の副作用が
// ReferenceError で落ちる。テストのために振る舞いを変えるのではなく、
// 拡張コンテキスト外で読み込まれた場合に安全側へ倒すガードとして扱う。
if (typeof chrome !== "undefined") {
  chrome.runtime.onMessage.addListener((message: Message) => {
    if (message.type !== "x/payload") return;

    void (async () => {
      try {
        // 本文を先に入れる。ファイルを添付すると X が UI を作り直すため、
        // その最中に入力すると焦点が定まらない
        const editor = await waitForElement<HTMLElement>(X_SELECTORS.editor);
        await insertText(editor, message.text);

        const input = await waitForElement<HTMLInputElement>(
          X_SELECTORS.fileInput,
        );
        const file = new File(
          [decodeBase64(message.base64)],
          message.fileName,
          { type: message.mimeType },
        );
        attachFile(input, file);

        // 投稿ボタンは押さない。最終確認はユーザーに委ねる
        notify({ type: "x/attached" });
      } catch (error) {
        notify({ type: "x/failed", reason: String(error) });
      }
    })();
  });

  // 投稿画面が開かれたことを service worker に知らせる
  if (location.pathname.startsWith("/compose/")) {
    notify({ type: "x/ready" });
  }
}
