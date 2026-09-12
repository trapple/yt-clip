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

/** paste が反映されるのを待つ時間 (ミリ秒) */
const PASTE_SETTLE_MS = 100;

/** 一致を確かめるために見る先頭の文字数 */
const HEAD_LENGTH = 20;

/** 添付後に本文が生き残ったか確かめる間隔と回数 */
const SURVIVE_CHECK_MS = 250;
const SURVIVE_CHECK_TIMES = 8;

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
export function containsHead(actual: string, expected: string): boolean {
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

/**
 * 添付した後も本文が残っているか確かめ、消えていたら入れ直す。
 *
 * **ファイルを添付すると X が入力欄を作り直すことがあり、先に入れた本文が
 * 消える。** 実機で、動画は「準備完了」になっているのに本文だけが空、という
 * 形で出た。二重入力を塞ぐまで表に出なかったのは、二回目の入力が添付の後に
 * 走っていて結果的に入れ直しになっていたため。
 *
 * 作り直しは添付の直後に一度起きるだけとは限らないので、しばらく見張る。
 */
export async function keepText(
  text: string,
  findEditor: () => HTMLElement | null,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; attempt < SURVIVE_CHECK_TIMES; attempt += 1) {
    await wait(SURVIVE_CHECK_MS);

    const editor = findEditor();
    // 作り直しの最中で入力欄が居ないことがある。次の周回で見直す
    if (editor === null) continue;

    // **「本文が見当たらない」ではなく「空」を条件にすること。** 守りたいのは
    // 「作り直しで空になった」場面だけで、そのとき中身は必ず空になる。
    // 本文の一致で判定すると、この 2 秒の間にユーザーが本文を書き換えたときに
    // 手で書いた内容を消して元に戻してしまう
    if ((editor.textContent ?? "").trim() !== "") continue;

    console.info(
      `[yt-clip] 添付で消えた本文を入れ直します (${attempt + 1} 回目)`,
    );
    // insertText が全選択して置き換えるので、入れ直しても積み上がらない
    await insertText(editor, text);

    // 入れた直後は反映が間に合わず「まだ無い」と読めることがある。
    // 一周ぶん待ってから次の確認に入る
    await wait(SURVIVE_CHECK_MS);
  }

  const editor = findEditor();
  console.info(
    `[yt-clip] 見張り終わり。入力欄は ${(editor?.textContent ?? "").length} 文字`,
    { 入力欄: editor?.textContent },
  );
}

export async function insertText(
  editor: HTMLElement,
  text: string,
): Promise<void> {
  editor.focus();

  // **全選択したまま入れて「置き換え」にすること。** 消してから入れる
  // (execCommand("delete") → insertText) と、Draft.js が持つ内部状態と DOM が
  // ずれて、入力欄が編集を受け付けなくなる。置き換えなら Draft.js が普通の
  // 編集として扱える。
  //
  // 全選択はもう 1 つ役目がある。X は前回の下書きを復元するので、末尾に
  // 足す形にすると本文が二重になる (実機で URL が 2 つ並んだ)。
  //
  // focus だけでは選択範囲が要素内に入らないことがあり、
  // その場合 execCommand は対象を見つけられずに false を返す
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  if (document.execCommand("insertText", false, text)) {
    // **入れた後の中身も出す。** 入れた文字列が正しくても、X 側の補完
    // (ハッシュタグの候補など) が後から書き換えることがある
    console.info(
      `[yt-clip] 本文を execCommand で入力しました (${text.length} 文字 → 入力欄 ${
        (editor.textContent ?? "").length
      } 文字)`,
      { 入れた文字列: text, 入力欄: editor.textContent },
    );
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
    console.info(
      `[yt-clip] 本文を paste で入力しました (${text.length} 文字 → 入力欄 ${
        (editor.textContent ?? "").length
      } 文字)`,
      { 入れた文字列: text, 入力欄: editor.textContent },
    );
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

    // 添付で入力欄が作り直されると本文が消える。消えたら入れ直す。
    // **ここの失敗で添付の成功を取り消さない。** 動画は既に X に載っており、
    // 失敗として扱うと popup がダウンロード誘導に変わってしまう
    try {
      await keepText(message.text, () =>
        document.querySelector<HTMLElement>(X_SELECTORS.editor.join(",")),
      );
    } catch (error) {
      console.warn(`[yt-clip] 本文の入れ直しに失敗しました: ${String(error)}`);
    }

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
