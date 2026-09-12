import { INITIAL_STATE, reduce } from "@/background/state";
import type { StoredClip } from "@/background/storage";
// MIME の扱いは録画形式の知識なので codec.ts に集約している (DOM 非依存)
import { baseMimeType } from "@/content/codec";
import { decodeBase64, encodeBase64 } from "@/shared/base64";
import { buildClipFileName } from "@/shared/filename";
import type { Message } from "@/shared/messages";
import { renderTemplate } from "@/shared/template";
import {
  BUSY_KINDS,
  type ClipEvent,
  type ClipState,
  type FailureReason,
} from "@/shared/types";

/** router が使う外部依存。テストではフェイクを渡す */
export type RouterDeps = {
  saveClip(clip: StoredClip): Promise<void>;
  getClip(id: string): Promise<StoredClip>;
  /** popup 宛。受け手が居ないことは正常なので送信側では扱わない */
  sendToRuntime(message: Message): void;
  /**
   * タブ宛。**受け手が居ないことは異常なので必ず失敗を返す。**
   * タブが閉じられた・content script が消えた場合、録画の続きを進める相手が
   * 居ないまま seeking / encoding で固まり、popup からも抜けられなくなる
   */
  sendToTab(tabId: number, message: Message): Promise<void>;
  openComposeTab(): Promise<number>;
  loadTemplate(): Promise<string>;
  /** UTC epoch ミリ秒 */
  now(): number;
  persist(snapshot: RouterSnapshot): Promise<void>;
  /** 指定時間後に呼び出す。戻り値を呼ぶと取り消す */
  startTimer(ms: number, onFire: () => void): () => void;
};

/**
 * 投稿画面の準備を待つ上限。
 * X に未ログインだと投稿画面ではなくログイン画面が開き、content script が
 * 準備完了を送ってこない。待ち続けると composing から抜けられなくなる。
 */
const COMPOSE_READY_TIMEOUT_MS = 30_000;

/**
 * タブへの指示に応答が返るのを待つ上限。
 *
 * 待ちは直列 queue の中で起きるため、応答が返らないと以降のメッセージが
 * 1 つも処理されなくなり、拡張を再読み込みするまで復帰できない。
 * **時間切れは「届かなかった」ではなく「応答が無かった」として扱う。**
 */
const TAB_COMMAND_TIMEOUT_MS = 5_000;

/** タブへの指示がどう終わったか */
type TabDelivery =
  /** 応答が返った */
  | "delivered"
  /** 応答が無かった。受け手は居て、処理も済んでいる見込みがある */
  | "no-response"
  /** 受け手が居ない。タブが失われている */
  | "unreachable";

/**
 * タブに受け手が居ないことを示す失敗か。
 *
 * `chrome.tabs.sendMessage` の reject には**意味が正反対の 2 種類**がある。
 *
 * - `Could not establish connection. Receiving end does not exist.`
 *   → リスナが 1 つも居ない。**本当にタブが失われている**
 * - `The message port closed before a response was received.`
 *   → リスナは居るが応答を返さなかった。**受け手は居て、処理も済んでいる**
 *
 * 後者はタブ側が `sendResponse` を呼ばなければ通常経路で起きるうえ、Chrome の
 * バージョンによって resolve するか reject するかが変わってきた領域でもある。
 * 区別せず「タブが失われた」と解釈すると、正常な録画も投稿も失敗に落ちる。
 */
export function isTabUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/.test(
    message,
  );
}

/** service worker が停止しても復元できるよう保存する内容 */
export type RouterSnapshot = {
  state: ClipState;
  captureTabId: number | null;
  composeTabId: number | null;
};

export type Router = {
  getState(): ClipState;
  handle(message: Message, senderTabId?: number): Promise<void>;
  /**
   * タブが閉じられた。録画対象のタブなら録画は続けられない。
   * service worker は数十秒で止まるためタイマーによる救済は当てにできず、
   * 閉じられたことを知る経路はこれしかない
   */
  handleTabRemoved(tabId: number): Promise<void>;
};

export function createRouter(
  deps: RouterDeps,
  initial?: RouterSnapshot,
): Router {
  let state: ClipState = initial?.state ?? INITIAL_STATE;
  let captureTabId: number | null = initial?.captureTabId ?? null;
  let composeTabId: number | null = initial?.composeTabId ?? null;
  /**
   * いまの投稿待ちで、本文と動画を既に送ったか。
   *
   * 投稿画面が二度読み込まれると `x/ready` も二度届く。一度目の添付が
   * 終わる前に二度目が来ると、どちらも `composing` を通り抜けて
   * **本文が二重に入る** (実機で確認)。送るのは一度だけにする
   */
  let payloadSent = false;
  /** 投稿画面の準備待ちを打ち切るためのハンドル */
  let cancelComposeTimeout: (() => void) | null = null;

  /**
   * タブへ指示を送り、結果を分類する。
   *
   * **応答が無いこと自体は失敗ではない。** 失敗に落としてよいのは
   * `isTabUnreachable` で受け手不在と分かったときだけ。
   */
  async function commandTab(
    tabId: number,
    message: Message,
  ): Promise<TabDelivery> {
    // startTimer は Promise の executor の中で同期的に呼ばれるので、
    // race を待つ時点では必ず本物の取り消し関数が入っている
    let cancelTimeout: () => void = () => undefined;
    const timedOut = new Promise<TabDelivery>((resolve) => {
      cancelTimeout = deps.startTimer(TAB_COMMAND_TIMEOUT_MS, () => {
        console.error(
          "タブへの指示が時間内に応答しませんでした",
          tabId,
          message.type,
        );
        resolve("no-response");
      });
    });

    const answered = deps.sendToTab(tabId, message).then(
      (): TabDelivery => "delivered",
      (error: unknown): TabDelivery => {
        if (isTabUnreachable(error)) return "unreachable";
        // 受け手は居る。理由を残さないと、後から区別がつかなくなる
        console.error(
          "タブへの指示に応答がありませんでした",
          tabId,
          message.type,
          error,
        );
        return "no-response";
      },
    );

    const delivery = await Promise.race([answered, timedOut]);
    cancelTimeout();
    return delivery;
  }

  /** 新しい状態を確定させ、関係者へ通知する */
  async function publish(next: ClipState): Promise<void> {
    // 投稿待ちを離れたらタイマーは用済み。残すと、取り直して録り直した後の
    // 関係ない場面で発火し、プレビューが勝手にダウンロード画面へ変わる。
    // 離脱経路は今後も増えうるので、個別に消さずここでまとめて始末する
    if (next.kind !== "composing") {
      cancelComposeTimeout?.();
      cancelComposeTimeout = null;
      // 次の投稿待ちでは改めて送る
      payloadSent = false;
    }

    state = next;
    await deps.persist({ state, captureTabId, composeTabId });

    const message: Message = { type: "state/changed", state };
    deps.sendToRuntime(message);

    const tabId = captureTabId;
    if (tabId !== null) {
      // **これはブロードキャストなので待たない。** publish は直列 queue の
      // 中で走るため、ここで応答を待つと、返ってこないときに以降のメッセージが
      // 1 つも処理されなくなる。タブが失われたかどうかは tabs.onRemoved と、
      // 実際に指示を出す recorder/start・recorder/stop・x/payload で判断する
      void deps.sendToTab(tabId, message).catch((error: unknown) => {
        console.error("録画対象のタブへ状態を届けられませんでした", tabId, error);
      });
    }
  }

  /**
   * `reduce` がこの遷移を拒んだか (新たに internal-error になったか) を判定する。
   *
   * 拒まれたイベントで状態を書き換えてはいけない。たとえば録画が
   * `recording-aborted` で失敗した後も YouTube の再生は続くので必ず OUT に達し、
   * `OUT_REACHED` が届く。これをそのまま反映すると、正当な失敗理由が
   * `internal-error` に潰れてユーザーに誤った説明が出る。
   */
  function isRejectedTransition(before: ClipState, after: ClipState): boolean {
    if (after.kind !== "failed" || after.reason !== "internal-error") {
      return false;
    }
    return !(before.kind === "failed" && before.reason === "internal-error");
  }

  /**
   * イベントを状態機械に適用する。**状態を変える経路はすべてここを通す。**
   * 拒まれた遷移なら `null` を返し、状態は書き換えない。
   *
   * 一部のイベントだけ直接 `publish` すると保護が抜ける。たとえば `x/failed` が
   * 二重に届いたとき、二度目は `downloadable` から拒まれる遷移になるが、それを
   * 書き換えてしまうと `failed` には `clipId` が無いため録画済みクリップへの
   * 参照ごと消える。
   *
   * @returns 適用前の状態。拒まれた場合は `null`
   */
  async function apply(event: ClipEvent): Promise<ClipState | null> {
    const next = reduce(state, event);
    // FAIL は明示的な失敗通知であり、`reduce` の invalid() フォールバックとは
    // 区別する。区別しないと「FAIL はどの状態からでも受理される」という
    // fail() 側の前提が崩れ、想定外の例外を internal-error として提示する
    // ための fail("internal-error") 呼び出しがここで握り潰されてしまう。
    if (event.type !== "FAIL" && isRejectedTransition(state, next)) {
      console.warn(
        `受け付けられない操作を無視しました: ${event.type} (状態: ${state.kind})`,
      );
      return null;
    }

    const previous = state;
    await publish(next);
    return previous;
  }

  async function fail(reason: FailureReason): Promise<void> {
    // FAIL はどの状態からでも受理されるので拒まれることはない
    await apply({ type: "FAIL", reason });
  }

  /** seek 完了後に録画を始めさせる。状態を進めるのは recorder/started を受けてから */
  async function beginRecording(): Promise<void> {
    // seek 完了は reduce を経由しないぶん、ここで状態を自分で確かめる。
    // 二度目の SEEK_DONE で余計な指示を出さないため
    if (state.kind !== "seeking") {
      console.warn(`録画準備中ではないので seek 完了を無視しました (状態: ${state.kind})`);
      return;
    }
    if (captureTabId === null) {
      await fail("tab-lost");
      return;
    }
    // 録画するのは content script。service worker は指示を出すだけ
    const delivery = await commandTab(captureTabId, { type: "recorder/start" });
    // 受け手が居ないと分かったときだけ落とす。応答が無いだけなら content
    // script は指示を受け取っている見込みで、recorder/started が続く
    if (delivery === "unreachable") {
      await fail("tab-lost");
    }
  }

  /**
   * 録画結果を受け取って保存する。
   * content script は拡張の IndexedDB を読み書きできないため、
   * base64 で運ばれてきたものをここで Blob に戻す。
   */
  async function storeRecording(
    base64: string,
    mimeType: string,
  ): Promise<void> {
    if (state.kind !== "encoding") {
      // 録画は実時間のコストを払い終えている。状態が想定と違うことは
      // 捨てる理由にならないが、範囲も動画情報も state にしか無いため保存できない
      console.error(`録画結果を保存できません (状態: ${state.kind})`);
      await fail("recording-aborted");
      return;
    }

    // **ここが録画データの入口。以降は素の MIME だけを扱う。**
    // content script から届くのは MediaRecorder 用のコーデック付き MIME
    // (`video/mp4;codecs="avc1.42E01E,mp4a.40.2"`)。そのまま持ち回ると、
    // 保存する Blob も、添付する File も、ダウンロードするファイルも
    // パラメータ付きのラベルになる。X はそれで対応形式の判定に落ちる
    const storedMime = baseMimeType(mimeType);

    const clipId = `clip-${deps.now()}`;
    await deps.saveClip({
      id: clipId,
      blob: new Blob([decodeBase64(base64)], { type: storedMime }),
      mimeType: storedMime,
      range: state.range,
      meta: state.meta,
      createdAt: deps.now(),
    });
    await apply({ type: "BLOB_READY", clipId, mimeType: storedMime });

    // MP4 でなければ X に添付できないが、録画済みの成果物は捨てない。
    // パラメータを落としても video/mp4 / video/webm の判定は変わらない
    if (!storedMime.includes("mp4")) {
      await apply({ type: "DEGRADE", reason: "mp4-unsupported" });
    }
  }

  async function sendPayload(): Promise<void> {
    if (state.kind !== "composing" || composeTabId === null) return;
    if (payloadSent) {
      console.info("本文と動画は送信済みのため、二度目の準備完了を無視しました");
      return;
    }
    // 待っている間に二度目が来ても弾けるよう、await の前に立てる
    payloadSent = true;

    // 待つ対象が「投稿画面の準備」から「添付の結果」に変わるだけで、
    // 待たなくてよくなるわけではない。タブを閉じられれば結果は永久に来ない
    cancelComposeTimeout?.();
    cancelComposeTimeout = deps.startTimer(COMPOSE_READY_TIMEOUT_MS, () => {
      cancelComposeTimeout = null;
      void apply({ type: "DEGRADE", reason: "x-attach-failed" });
    });

    const clip = await deps.getClip(state.clipId);
    const template = await deps.loadTemplate();
    const delivery = await commandTab(composeTabId, {
      type: "x/payload",
      base64: encodeBase64(new Uint8Array(await clip.blob.arrayBuffer())),
      mimeType: clip.mimeType,
      fileName: buildClipFileName(
        clip.meta.videoId,
        clip.range.startSec,
        clip.mimeType,
      ),
      text: renderTemplate(template, clip.meta, clip.range),
    });

    // 投稿タブに受け手が居ないと分かった場合だけ退避する。応答が無いだけで
    // 退避すると、**添付は投稿タブで正常に進んでいるのに** popup が
    // ダウンロード誘導になり、後から届く x/attached は downloadable から
    // 拒まれて戻れなくなる。待ちすぎは COMPOSE_READY_TIMEOUT_MS が拾う
    if (delivery === "unreachable") {
      await apply({ type: "DEGRADE", reason: "x-attach-failed" });
    }
  }

  async function handleEvent(
    event: ClipEvent,
    senderTabId?: number,
  ): Promise<void> {
    // 録画中の範囲変更は受け付けない。`reduce` は MARK_IN をどの状態からでも
    // 受理してしまうため、ここで止めないと状態機械だけが ready に戻り、
    // 録画中の content script は指示を受けないまま走り続ける。UI 側でも
    // 同じガードを持っているが、状態変化を受け取っていない別タブからの
    // MARK_IN は UI 側では防げないので、録画対象タブを奪われないよう
    // ここでも守る。
    if (event.type === "MARK_IN" && BUSY_KINDS.has(state.kind)) {
      console.warn(`録画中の範囲変更を無視しました (状態: ${state.kind})`);
      return;
    }

    if (event.type === "MARK_IN" && senderTabId !== undefined) {
      captureTabId = senderTabId;
    }

    // seek 完了は即座に反映しない。録画が始まってから recording へ進める
    if (event.type === "SEEK_DONE") {
      await beginRecording();
      return;
    }

    const previous = await apply(event);
    if (previous === null) return;

    // 副作用は「イベントが届いたから」ではなく「状態が実際に進んだから」実行する。
    // イベント種別だけで判断すると、START_RECORDING が二度届いたときに
    // 二度目でも録画準備が走り、状態と実際の動作が食い違う。
    if (state.kind === previous.kind) return;

    if (state.kind === "encoding") {
      if (captureTabId === null) {
        await fail("tab-lost");
        return;
      }
      const delivery = await commandTab(captureTabId, {
        type: "recorder/stop",
      });
      // 応答が無いだけなら encoding のまま待つ。実時間をかけた録画結果が
      // 後から届くことがあり、ここで失敗に落とすと storeRecording が
      // 「encoding ではない」として成果物を捨ててしまう
      if (delivery === "unreachable") {
        await fail("tab-lost");
      }
      return;
    }
    if (state.kind === "composing") {
      composeTabId = await deps.openComposeTab();

      // 投稿画面が用意できないまま待ち続けると composing から抜けられなくなる。
      // X に未ログインだとログイン画面が開き、準備完了は永久に来ない
      cancelComposeTimeout?.();
      cancelComposeTimeout = deps.startTimer(COMPOSE_READY_TIMEOUT_MS, () => {
        cancelComposeTimeout = null;
        void apply({ type: "DEGRADE", reason: "x-attach-failed" });
      });
    }
  }

  /**
   * content script が読み込まれた。
   *
   * 録画中にタブをリロードすると、OUT を監視していた content script ごと消える。
   * タブは生きているので `tabs.onRemoved` は発火せず、`state/changed` も起きない
   * ので送信失敗からも気付けない。`OUT_REACHED` は永久に来ず、popup にも押せる
   * ボタンが無い。ここが唯一の抜け道になる。
   *
   * **録画対象のタブからの通知でなければ何もしない。** 録画中に別の YouTube
   * タブを開いただけで、進行中の録画を落としてしまう。
   */
  async function handleContentLoaded(senderTabId?: number): Promise<void> {
    if (senderTabId === undefined || senderTabId !== captureTabId) return;
    if (!BUSY_KINDS.has(state.kind)) return;

    // 理由を残さないと、popup の「録画が中断されました」だけでは原因を追えない
    console.error(
      `録画中に対象タブが読み込み直されました (状態: ${state.kind})`,
      senderTabId,
    );
    await fail("recording-aborted");
  }

  async function route(
    message: Message,
    senderTabId?: number,
  ): Promise<void> {
    switch (message.type) {
      case "clip/event":
        await handleEvent(message.event, senderTabId);
        return;
      case "content/loaded":
        await handleContentLoaded(senderTabId);
        return;
      case "recorder/started":
        await apply({ type: "SEEK_DONE" });
        return;
      case "recorder/done":
        await storeRecording(message.base64, message.mimeType);
        return;
      case "recorder/failed":
        // 理由を捨てると、どの段階で録画が壊れたのかが後から追えない
        console.error("録画に失敗しました", message.reason);
        await fail("recording-aborted");
        return;
      case "x/ready":
        await sendPayload();
        return;
      case "x/attached":
        // タイマーの始末は publish がまとめて行う
        await apply({ type: "ATTACHED" });
        return;
      case "x/failed":
        console.error("X への添付に失敗しました", message.reason);
        await apply({ type: "DEGRADE", reason: "x-attach-failed" });
        return;
      default:
        // state/get と state/changed は router の処理対象外
        return;
    }
  }

  /**
   * 処理中の連鎖。メッセージは 1 つずつ順に処理する。
   * 保存など時間のかかる副作用の最中に別のメッセージが状態を進めると、
   * 戻ってきたときの遷移が拒まれて録画済みクリップへの参照を失う。
   *
   * **不変条件: この中で settle しない Promise を待たないこと。**
   * 1 つ止まれば以降のメッセージが 1 つも処理されず、拡張を再読み込みする
   * まで復帰できない。別のコンテキスト (タブ) の応答を待つものは、必ず
   * `commandTab` のように上限を付けてから待つ。
   */
  let queue: Promise<void> = Promise.resolve();

  return {
    getState: () => state,

    handle(message: Message, senderTabId?: number): Promise<void> {
      queue = queue.then(async () => {
        try {
          await route(message, senderTabId);
        } catch (error) {
          // 想定できていない失敗。黙って止まると、状態が途中のまま
          // ユーザーには何も伝わらない
          console.error("メッセージの処理に失敗しました", message.type, error);

          // 録画済みクリップを抱えている状態を failed で潰すと、
          // failed は clipId を持たないためデータへの参照ごと失われる。
          // 保存済みのものは必ずダウンロードで回収できる形に倒す
          const holdsClip =
            state.kind === "preview" || state.kind === "composing";
          const recovery: ClipEvent = holdsClip
            ? { type: "DEGRADE", reason: "x-attach-failed" }
            : { type: "FAIL", reason: "internal-error" };
          await apply(recovery).catch(() => undefined);
        }
      });
      return queue;
    },

    handleTabRemoved(tabId: number): Promise<void> {
      queue = queue.then(async () => {
        if (tabId !== captureTabId) return;
        // このタブへはもう何も届かない。次の指示先として使わせない
        captureTabId = null;

        try {
          // 死んだ tabId をスナップショットに残すと、service worker が
          // 再起動したときに復活して指示先に戻る
          await deps.persist({ state, captureTabId, composeTabId });

          // 録画の進行中だけ失敗に落とす。preview / composing は録画済みの
          // クリップを抱えており、failed には clipId が無いため参照ごと失う。
          // ready で閉じられた場合は、録画開始時に tab-lost として弾かれる
          if (BUSY_KINDS.has(state.kind)) {
            await fail("tab-lost");
          }
        } catch (error) {
          console.error("タブ消失の反映に失敗しました", error);
        }
      });
      return queue;
    },
  };
}
