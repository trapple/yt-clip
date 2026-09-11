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

/** 本文を入力する。contenteditable への代入では React の state に反映されない */
export function insertText(editor: HTMLElement, text: string): void {
  editor.focus();
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    throw new Error("本文を入力できませんでした");
  }
}

function notify(message: Message): void {
  void chrome.runtime.sendMessage(message);
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
        const input = await waitForElement<HTMLInputElement>(
          X_SELECTORS.fileInput,
        );
        const file = new File(
          [decodeBase64(message.base64)],
          message.fileName,
          { type: message.mimeType },
        );
        attachFile(input, file);

        const editor = await waitForElement<HTMLElement>(X_SELECTORS.editor);
        insertText(editor, message.text);

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
