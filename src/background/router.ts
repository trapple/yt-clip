import { INITIAL_STATE, reduce } from "@/background/state";
import type { StoredClip } from "@/background/storage";
import { encodeBase64 } from "@/shared/base64";
import { buildClipFileName } from "@/shared/filename";
import type { Message } from "@/shared/messages";
import { renderTemplate } from "@/shared/template";
import type { ClipEvent, ClipState, FailureReason } from "@/shared/types";

/** router が使う外部依存。テストではフェイクを渡す */
export type RouterDeps = {
  ensureOffscreen(): Promise<void>;
  getStreamId(tabId: number): Promise<string>;
  getClip(id: string): Promise<StoredClip>;
  /** offscreen / popup 宛。受け手が居ないことは正常なので送信側では扱わない */
  sendToRuntime(message: Message): void;
  sendToTab(tabId: number, message: Message): void;
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

/** service worker が停止しても復元できるよう保存する内容 */
export type RouterSnapshot = {
  state: ClipState;
  captureTabId: number | null;
  composeTabId: number | null;
};

export type Router = {
  getState(): ClipState;
  handle(message: Message, senderTabId?: number): Promise<void>;
};

/** 録画が進行中で、範囲の変更を受け付けない状態 */
const BUSY_KINDS: ReadonlySet<ClipState["kind"]> = new Set([
  "seeking",
  "recording",
  "encoding",
]);

export function createRouter(
  deps: RouterDeps,
  initial?: RouterSnapshot,
): Router {
  let state: ClipState = initial?.state ?? INITIAL_STATE;
  let captureTabId: number | null = initial?.captureTabId ?? null;
  let composeTabId: number | null = initial?.composeTabId ?? null;
  let streamId: string | null = null;
  /** 投稿画面の準備待ちを打ち切るためのハンドル */
  let cancelComposeTimeout: (() => void) | null = null;

  /** 新しい状態を確定させ、関係者へ通知する */
  async function publish(next: ClipState): Promise<void> {
    state = next;
    await deps.persist({ state, captureTabId, composeTabId });

    const message: Message = { type: "state/changed", state };
    deps.sendToRuntime(message);
    if (captureTabId !== null) {
      deps.sendToTab(captureTabId, message);
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

  /** 録画の下準備。動画はまだ進めない */
  async function prepareCapture(): Promise<void> {
    if (captureTabId === null) {
      await fail("tab-lost");
      return;
    }
    try {
      await deps.ensureOffscreen();
      streamId = await deps.getStreamId(captureTabId);
    } catch (error) {
      // 理由を捨てると、権限を拒否されたのか offscreen を作れなかったのかが
      // 後から追えない。ユーザーに見せる文言は 1 つでも、原因は残しておく
      console.error("録画の準備に失敗しました", error);
      await fail("capture-permission-denied");
    }
  }

  /** seek 完了後に録画を始めさせる。状態を進めるのは recorder/started を受けてから */
  async function beginRecording(): Promise<void> {
    // seek 完了は reduce を経由しないぶん、ここで状態を自分で確かめる。
    // 二度目の SEEK_DONE を権限エラーとして報告しないため。
    if (state.kind !== "seeking") {
      console.warn(`録画準備中ではないので seek 完了を無視しました (状態: ${state.kind})`);
      return;
    }
    if (streamId === null) {
      await fail("capture-permission-denied");
      return;
    }

    // 保存先を先に決めて offscreen へ渡す。録画データは offscreen が直接
    // IndexedDB へ書く (拡張のメッセージには載せられないため)
    deps.sendToRuntime({
      type: "recorder/start",
      streamId,
      clipId: `clip-${deps.now()}`,
      range: state.range,
      meta: state.meta,
    });
    streamId = null;
  }

  /**
   * 録画の完了を受け取る。データは offscreen が既に保存済みで、ここでは
   * 状態を進めるだけ。保存済みのものを状態の都合で捨ててはいけない。
   */
  async function storeRecording(
    clipId: string,
    mimeType: string,
  ): Promise<void> {
    await apply({ type: "BLOB_READY", clipId, mimeType });

    // MP4 でなければ X に添付できないが、録画済みの成果物は捨てない
    if (!mimeType.includes("mp4")) {
      await apply({ type: "DEGRADE", reason: "mp4-unsupported" });
    }
  }

  async function sendPayload(): Promise<void> {
    if (state.kind !== "composing" || composeTabId === null) return;

    // 待つ対象が「投稿画面の準備」から「添付の結果」に変わるだけで、
    // 待たなくてよくなるわけではない。タブを閉じられれば結果は永久に来ない
    cancelComposeTimeout?.();
    cancelComposeTimeout = deps.startTimer(COMPOSE_READY_TIMEOUT_MS, () => {
      cancelComposeTimeout = null;
      void apply({ type: "DEGRADE", reason: "x-attach-failed" });
    });

    const clip = await deps.getClip(state.clipId);
    const template = await deps.loadTemplate();
    deps.sendToTab(composeTabId, {
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
  }

  async function handleEvent(
    event: ClipEvent,
    senderTabId?: number,
  ): Promise<void> {
    // 録画中の範囲変更は受け付けない。`reduce` は MARK_IN をどの状態からでも
    // 受理してしまうため、ここで止めないと状態機械だけが marking に戻り、
    // offscreen の録画は解放されないまま走り続ける。UI 側でも同じガードを
    // 持っているが、状態変化を受け取っていない別タブからの MARK_IN は
    // UI 側では防げないので、録画対象タブを奪われないようここでも守る。
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

    if (state.kind === "seeking") {
      await prepareCapture();
      return;
    }
    if (state.kind === "encoding") {
      deps.sendToRuntime({ type: "recorder/stop" });
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

  async function route(
    message: Message,
    senderTabId?: number,
  ): Promise<void> {
    switch (message.type) {
      case "clip/event":
        await handleEvent(message.event, senderTabId);
        return;
      case "recorder/started":
        await apply({ type: "SEEK_DONE" });
        return;
      case "recorder/done":
        await storeRecording(message.clipId, message.mimeType);
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
        cancelComposeTimeout?.();
        cancelComposeTimeout = null;
        await apply({ type: "ATTACHED" });
        return;
      case "x/failed":
        cancelComposeTimeout?.();
        cancelComposeTimeout = null;
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
  };
}
