import { pickMimeType } from "@/content/codec";
import {
  getVideo,
  getVideoMeta,
  isAdPlaying,
  onReachTime,
  parseVideoId,
  seekTo,
  startPlayback,
} from "@/content/player";
import { createRangeBar, type RangeBar } from "@/content/range-bar";
import { makeDefaultRange } from "@/content/range-math";
import {
  DrmProtectedError,
  assertRecordable,
  startRecording,
  type RecorderHandle,
} from "@/content/recorder";
import { YT_SELECTORS } from "@/content/selectors";
import { encodeBase64 } from "@/shared/base64";
import type { Message, MessageResponse } from "@/shared/messages";
import { formatTime, validateRange } from "@/shared/time";
// BUSY_KINDS は状態の性質なので types.ts で共有している
import {
  BUSY_KINDS,
  FAILURE_MESSAGES,
  type ClipEvent,
  type ClipRange,
  type ClipState,
} from "@/shared/types";

const BAR_ID = "yt-clip-bar";
/** 拡大バーの要素。位置ではなく id で辿れるようにする */
const RANGE_ID = "yt-clip-range";
const OVERLAY_ID = "yt-clip-overlay";

/**
 * 録画品質は再生解像度が上限になるため、低いときは事前に知らせる。
 * `captureStream()` が返すのはデコード済みのフレームなので、解像度は
 * 再生中の画質そのものになる。360p で再生していれば 360p で録れる。
 */
const MIN_RECOMMENDED_HEIGHT = 720;

/** いま指定されている範囲。service worker と同じものを持つ */
let currentRange: ClipRange | null = null;
/** 範囲を作ったときの動画。SPA で動画が変わったら無効になる */
let rangeVideoId: string | null = null;
let busy = false;
/** 範囲を変更してよい状態か。状態機械が ready のときだけ真 */
let rangeEditable = false;
let cancelWatch: (() => void) | null = null;
let cancelPreview: (() => void) | null = null;
let rangeBar: RangeBar | null = null;
let handle: RecorderHandle | null = null;

/**
 * 状態機械へイベントを送る。
 *
 * `accepted` を渡すと、応答に載ってくる「適用後の状態」で結果を確かめる。
 * 受け付けられなかった操作では状態が変わらず `state/changed` も飛ばないため、
 * 送り手が結果を知る手段はこの応答しかない (`src/background/sw.ts` 参照)。
 */
function send(
  event: ClipEvent,
  accepted?: (state: ClipState) => boolean,
): void {
  void chrome.runtime
    .sendMessage({ type: "clip/event", event } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (response === undefined) {
        setStatus("拡張から応答がありませんでした");
        return;
      }
      if (accepted === undefined || accepted(response.state)) return;

      // 画面だけが新しい範囲になって状態と食い違っている。正である
      // 状態機械の側へ画面を戻したうえで、拒まれたことを伝える
      applyStateToDisplay(response.state);
      setStatus(
        `この操作は受け付けられませんでした (状態: ${response.state.kind})`,
      );
    })
    .catch((error: unknown) => {
      setStatus(`操作を送信できませんでした: ${String(error)}`);
    });
}

/**
 * service worker へ録画の進行を伝える。
 *
 * 録画結果は base64 で数十 MB になりうる。メッセージ長の超過や拡張コンテキストの
 * 無効化で送れなかったとき、黙って捨てると service worker は `encoding` のまま、
 * popup は `actions: []` で操作不能になる。ユーザーに見せたうえで、小さい
 * `FAIL` を送って状態を抜けさせる。
 */
function notify(message: Message): void {
  void chrome.runtime.sendMessage(message).catch((error: unknown) => {
    setStatus(`拡張への送信に失敗しました: ${String(error)}`);
    // 成果物を渡せていない以上、録画が中断されたのと結果は同じ
    send({ type: "FAIL", reason: "recording-aborted" });
  });
}

function setStatus(text: string): void {
  const status = document.getElementById(`${BAR_ID}-status`);
  if (status !== null) {
    status.textContent = text;
  }
}

/**
 * クリック操作を包んで、失敗をユーザーに見える形にする。
 * 要素が見つからない・再生位置が不正といった失敗を console に流すだけでは、
 * ボタンが無反応になった理由がユーザーに伝わらない。
 */
function guard(action: () => void): () => void {
  return () => {
    try {
      action();
    } catch (error) {
      setStatus(`操作できませんでした: ${String(error)}`);
    }
  };
}

/** 範囲を人が読める形にする。同じ文言を 3 箇所で使うのでここに集める */
function rangeLabel(range: ClipRange): string {
  const durationSec = Math.round(range.endSec - range.startSec);
  return `${formatTime(range.startSec)} 〜 ${formatTime(range.endSec)} (${durationSec}秒)`;
}

/** 同じ範囲を指しているか。別のオブジェクトでも値が同じなら同じ範囲 */
function sameRange(a: ClipRange, b: ClipRange): boolean {
  return a.startSec === b.startSec && a.endSec === b.endSec;
}

/**
 * いま開いている動画の videoId。動画ページでなければ null。
 * 再生画面から離れること自体は異常ではないので、例外にはしない。
 */
function currentVideoId(): string | null {
  try {
    return parseVideoId(location.href);
  } catch {
    return null;
  }
}

/**
 * 拡大バーを操作してよいか。
 *
 * 範囲を変えられるのは状態機械が `ready` のときだけで、かつ範囲を作った動画を
 * 見ているときだけ。`!busy` を条件にすると、`preview` (録画済みでポスト待ち)
 * でもハンドルが動いてしまう。service worker は `ADJUST_RANGE` を拒むため、
 * 画面だけが新しい範囲になって状態と食い違う。
 */
function canAdjustRange(): boolean {
  return (
    rangeEditable && rangeVideoId !== null && rangeVideoId === currentVideoId()
  );
}

/**
 * 範囲再生の監視を解除する。
 *
 * 解除し忘れると、範囲を変えた後や録画中に**登録時の OUT 位置**を通過した
 * 瞬間へ `video.pause()` が飛ぶ。録画中なら新しい OUT へ永久に到達せず、
 * `OUT_REACHED` が送られないまま `recording` で固まって復帰できなくなる。
 */
function cancelPreviewWatch(): void {
  cancelPreview?.();
  cancelPreview = null;
}

/**
 * 走ったままの録画を止めて捨てる。
 *
 * 状態が録画から離れたのに MediaRecorder が回り続けると、chunk がメモリへ
 * 積み上がり captureStream のトラックも解放されない。次の録画が `handle` を
 * 上書きすると、古い recorder は誰からも止められなくなる。
 */
function abortRecording(): void {
  if (handle === null) return;

  const aborting = handle;
  handle = null;
  void aborting.stop().catch((error: unknown) => {
    // 録画中のエラーで reject するが、状態は既に失敗として確定しており、
    // ここで重ねて報告しても伝わる情報は増えない。記録だけ残す
    console.warn(`録画の後始末に失敗しました: ${String(error)}`);
  });
}

function applyRange(range: ClipRange, videoDurationSec: number): void {
  // 範囲が変われば、前の範囲を見ている監視は用済み
  cancelPreviewWatch();

  currentRange = range;
  rangeBar?.update(range, videoDurationSec);
  paintOverlay(range, videoDurationSec);
  setStatus(rangeLabel(range));
}

function onMarkIn(): void {
  // 録画中に打ち直されると状態機械だけが範囲を作り直し、録画は走り続けて
  // 取り残される。状態機械と router にも同じガードがあるが、ここで止めれば
  // ユーザーに理由をすぐ返せる。
  //
  // **ドラッグ (canAdjustRange) と違い、IN は preview からでも受け付ける。**
  // spec §5.6 の「MARK_IN はどの状態からでも ready へ」を content script 側で
  // 狭めると、録り終えた後に次の切り抜きを始められなくなるため。代償として、
  // 録画済みクリップへの参照 (clipId) は状態から外れる (IndexedDB には残るが
  // popup から辿れなくなる)。この非対称は意図したもの
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }

  const video = getVideo();
  const meta = getVideoMeta();
  // 既定の長さの範囲をここで作る。状態機械は長さの決め方を知らない
  const range = makeDefaultRange(video.currentTime, video.duration);

  rangeVideoId = meta.videoId;
  applyRange(range, video.duration);
  send(
    { type: "MARK_IN", range, meta },
    (state) => state.kind === "ready" && sameRange(state.range, range),
  );
}

function onMarkOut(): void {
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }
  if (currentRange === null) {
    setStatus("先に IN を指定してください");
    return;
  }

  // IN を打った後に別の動画へ移動していた場合、その範囲はもう意味を持たない。
  // ここで RESET_MARKS を送ってはいけない。録画済みで投稿待ちのときに届くと
  // 状態機械が不正遷移として failed に落ち、クリップへの参照ごと失う
  if (getVideoMeta().videoId !== rangeVideoId) {
    currentRange = null;
    rangeVideoId = null;
    clearOverlay();
    // 同じ状況を指す文言は 1 つにする (失敗として届く場合と同じ言い回し)
    setStatus(FAILURE_MESSAGES["video-changed"]);
    return;
  }

  const video = getVideo();
  const next = { startSec: currentRange.startSec, endSec: video.currentTime };
  const validation = validateRange(next.startSec, next.endSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }

  applyRange(next, video.duration);
  send(
    { type: "MARK_OUT", sec: next.endSec },
    (state) => state.kind === "ready" && sameRange(state.range, next),
  );
}

/**
 * 拡大バーでのドラッグが確定したとき。
 *
 * 拡大バーから直接呼ばれるので click 用の guard を通らない。ここで落とすと
 * 範囲が service worker へ送られず、画面の見た目だけが新しい範囲になって
 * 実際の状態と食い違う
 */
function onRangeCommitted(range: ClipRange): void {
  // 状態機械が受け付けない範囲変更は、画面にも反映しない
  if (!canAdjustRange()) return;

  cancelPreviewWatch();

  try {
    // 動画が取れるかを先に確かめる。範囲を覚えてから落ちると、送っていない
    // 範囲が content script 側にだけ残り、まさにこの関数が防ごうとしている
    // 「画面と状態の食い違い」が起きる
    const durationSec = getVideo().duration;

    currentRange = range;
    paintOverlay(range, durationSec);
    setStatus(rangeLabel(range));
    send(
      { type: "ADJUST_RANGE", range },
      (state) => state.kind === "ready" && sameRange(state.range, range),
    );
  } catch (error) {
    setStatus(`範囲を確定できませんでした: ${String(error)}`);
  }
}

/**
 * ドラッグ中の追従。動かしている側の位置を見せる。
 *
 * 追従できなくてもドラッグは続けさせる。ここで投げるとフレームごとに
 * 例外が出るうえ、ハンドルまで動かせなくなる。範囲の指定という本来の
 * 目的は追従なしでも達成できる
 */
function onScrub(sec: number): void {
  try {
    const video = getVideo();
    video.pause();
    video.currentTime = sec;
  } catch {
    // 動画が一瞬取れないだけ。次のフレームで拾い直せる
  }
}

/** YouTube のシークバーに範囲を帯で重ねて、動画全体のどこかを示す */
function paintOverlay(range: ClipRange, videoDurationSec: number): void {
  const bar = document.querySelector<HTMLElement>(YT_SELECTORS.progressBar);
  if (bar === null || videoDurationSec <= 0) return;

  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay === null) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      "position:absolute;top:0;bottom:0;background:#3ea6ff;opacity:0.5;pointer-events:none;z-index:1;";
    bar.appendChild(overlay);
  }

  overlay.style.left = `${(range.startSec / videoDurationSec) * 100}%`;
  overlay.style.width = `${((range.endSec - range.startSec) / videoDurationSec) * 100}%`;
}

/** 帯を取り除く。範囲を失った状態や、別の動画を見ているときに残さない */
function clearOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

/** 帯を今の範囲に合わせ直す。範囲が無い・別の動画を見ているなら消す */
function refreshOverlay(): void {
  if (currentRange === null || rangeVideoId !== currentVideoId()) {
    clearOverlay();
    return;
  }
  try {
    paintOverlay(currentRange, getVideo().duration);
  } catch (error) {
    // 帯は範囲の目安にすぎない。描けないことは録画を止める理由にならない
    console.warn(`範囲の帯を描き直せませんでした: ${String(error)}`);
  }
}

/**
 * 状態機械が持つ範囲を画面へ反映する。**食い違ったときは状態機械が正。**
 * 表示だけを扱い、録画そのものには触れない。
 */
function applyStateToDisplay(state: ClipState): void {
  const stateRange = "range" in state ? state.range : null;
  const stateMeta = "meta" in state ? state.meta : null;
  // idle と failed が持つ範囲は「もう操作できない過去のもの」。画面から消す。
  // failed から RETRY で戻るときは、ready の state/changed が範囲を持ってくる。
  //
  // **別の動画を見ているタブでは取り込まない。** 状態機械の範囲は他の動画の
  // ものなので、覚えてしまうとステータス行に別動画の範囲が出るうえ、
  // 「範囲を再生」でこの動画をその位置へ飛ばしてしまう (canAdjustRange と同じ規則)
  const liveRange =
    state.kind === "idle" ||
    state.kind === "failed" ||
    stateMeta?.videoId !== currentVideoId()
      ? null
      : stateRange;

  const drifted =
    currentRange === null || liveRange === null
      ? currentRange !== liveRange
      : !sameRange(currentRange, liveRange);

  busy = BUSY_KINDS.has(state.kind);
  rangeEditable = state.kind === "ready";
  currentRange = liveRange;
  // どの動画の範囲かも状態機械が持っている。content script が読み込み
  // 直された後でも、これで取り戻せる
  rangeVideoId = stateMeta?.videoId ?? null;

  rangeBar?.setEnabled(canAdjustRange());
  refreshOverlay();

  // 失敗はバーにも出す。録画中にタブをリロードした場合、このバーが
  // 唯一の手がかりになる (popup を開かない限り理由が分からない)
  if (state.kind === "failed") {
    setStatus(FAILURE_MESSAGES[state.reason]);
  }

  // 拡大バーを描き直すのは、表示がずれているときだけにする。確定のたびに
  // 描き直すと窓が計算し直されてハンドルが跳ねる。
  // ただし録画中は、打ち切られたドラッグの見た目が最後の位置に残るため、
  // ずれていなくても確定済みの範囲で描き直す
  if (currentRange !== null && (drifted || busy)) {
    try {
      rangeBar?.update(currentRange, getVideo().duration);
    } catch (error) {
      // ここは同期リスナーの中。投げると呼び出し元の録画処理まで届かず、
      // SEEK_DONE が送られないまま録画が無音で止まる。
      // 表示の乱れは録画を止める理由にならないため、失敗しても先へ進める
      console.warn(`拡大バーの再描画に失敗しました: ${String(error)}`);
    }
  }
}

/** 指定した範囲を通しで再生して内容を確認する */
async function playRange(): Promise<void> {
  if (currentRange === null || busy) return;

  cancelPreviewWatch();

  const range = currentRange;
  try {
    // getVideo() を try の外に置くと、この関数は async なので同期的な throw が
    // Promise の拒否になり、呼び出し元の `void playRange()` で握り潰されて
    // ボタンが無反応に見える。onReachTime の登録まで含めて 1 つの try で拾う
    const video = getVideo();
    await seekTo(video, range.startSec);
    await startPlayback(video);

    setStatus(`範囲を再生中… (${Math.round(range.endSec - range.startSec)}秒)`);
    cancelPreview = onReachTime(video, range.endSec, () => {
      cancelPreview = null;
      // 登録したときの範囲を今も使っているかを確かめる。解除が漏れていた
      // 場合にここで止めると、別の範囲の再生や録画まで巻き込んで止める
      if (busy || currentRange === null || !sameRange(currentRange, range)) {
        return;
      }
      video.pause();
      setStatus(rangeLabel(range));
    });
  } catch (error) {
    setStatus(`範囲を再生できませんでした: ${String(error)}`);
  }
}

/**
 * 録画の前半。IN へ seek するが再生はしない。
 * service worker が録画開始を指示し、それを受けた録画が実際に始まるまで
 * 動画を進めないため。
 */
async function prepareRecording(
  startSec: number,
  expectedVideoId: string,
): Promise<void> {
  try {
    // 範囲を作った動画と今の動画が違えば、範囲もタイトルも URL も別の動画の
    // もの。そのまま録ると B の映像に A のタイトルと URL が付いて投稿される。
    // IN 単独で ready になれるため、OUT を押さずに録画へ進む経路がある
    if (currentVideoId() !== expectedVideoId) {
      send({ type: "FAIL", reason: "video-changed" });
      // 状態機械から返ってくる文言と同じものを先に出す。違う言い回しを
      // 出すと、直後に届く state/changed で表示が言い換わって見える
      setStatus(FAILURE_MESSAGES["video-changed"]);
      return;
    }

    // 保護された動画は captureStream が黒画面を返すだけで失敗しない。
    // 実時間を払い切ってから無駄と分かることのないよう、ここで弾く
    assertRecordable(getVideo());

    if (isAdPlaying()) {
      send({ type: "FAIL", reason: "ad-playing" });
      setStatus("広告の再生中です。終了後にやり直してください");
      return;
    }

    const video = getVideo();
    // 画質は録画してからでは上げられないので、この時点で警告する (録画は
    // 止めない)。captureStream が返すのは再生中のフレームなので、低い画質の
    // まま録れば低い画質のクリップになる。準備中の表示に混ぜて出すのは、
    // 単独で出すと次の表示にすぐ上書きされて読む間がないため
    const qualityNote =
      video.videoHeight > 0 && video.videoHeight < MIN_RECOMMENDED_HEIGHT
        ? `再生画質が低いままです (${video.videoHeight}p)。画質を上げると綺麗に切り抜けます。`
        : "";

    video.pause();
    await seekTo(video, startSec);

    send({ type: "SEEK_DONE" });
    setStatus(`${qualityNote}録画の準備をしています…`);
  } catch (error) {
    if (error instanceof DrmProtectedError) {
      send({ type: "FAIL", reason: "drm-protected" });
      setStatus(error.message);
      return;
    }
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`開始位置へ移動できませんでした: ${String(error)}`);
  }
}

/** service worker からの指示で録画を始める */
async function beginRecording(): Promise<void> {
  try {
    const video = getVideo();
    const { mimeType } = pickMimeType();
    handle = await startRecording(video, mimeType, {
      onUnexpectedStop: (error) => {
        handle = null;
        notify({ type: "recorder/failed", reason: error.message });
      },
    });
    notify({ type: "recorder/started" });
  } catch (error) {
    notify({ type: "recorder/failed", reason: String(error) });
  }
}

/** 録画の後半。録画開始後に呼ばれ、再生して OUT 到達で停止する */
async function runRecording(startSec: number, endSec: number): Promise<void> {
  try {
    const video = getVideo();
    await startPlayback(video);

    setStatus(`録画中… (${Math.round(endSec - startSec)}秒)`);

    cancelWatch = onReachTime(video, endSec, () => {
      cancelWatch = null;
      video.pause();
      send({ type: "OUT_REACHED" });
      setStatus("録画を書き出しています…");
    });
  } catch (error) {
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
  }
}

/** 録画を止めて結果を送る。拡張の IndexedDB は content script から触れない */
async function finishRecording(): Promise<void> {
  if (handle === null) {
    notify({ type: "recorder/failed", reason: "録画が開始されていません" });
    return;
  }

  const stopping = handle;
  handle = null;
  try {
    const blob = await stopping.stop();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    notify({
      type: "recorder/done",
      base64: encodeBase64(bytes),
      mimeType: blob.type,
    });
  } catch (error) {
    notify({ type: "recorder/failed", reason: String(error) });
  }
}

function buildBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText =
    "display:flex;flex-direction:column;gap:4px;padding:8px 0;color:var(--yt-spec-text-primary,#fff);font-size:13px;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center;";

  const inButton = document.createElement("button");
  inButton.textContent = "IN";
  inButton.addEventListener("click", guard(onMarkIn));

  const outButton = document.createElement("button");
  outButton.textContent = "OUT";
  outButton.addEventListener("click", guard(onMarkOut));

  const playButton = document.createElement("button");
  playButton.textContent = "範囲を再生";
  playButton.addEventListener("click", guard(() => void playRange()));

  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.textContent = "IN を押して開始位置を指定";

  row.append(inButton, outButton, playButton, status);

  // 拡大バーは生成直後は無効。範囲が確定して ready になったら有効化される
  rangeBar = createRangeBar({ onScrub, onCommit: onRangeCommitted });
  rangeBar.element.id = RANGE_ID;
  bar.append(row, rangeBar.element);
  return bar;
}

function mount(): void {
  if (document.getElementById(BAR_ID) !== null) return;

  const anchor = document.querySelector(YT_SELECTORS.mountAnchor);
  if (anchor === null) return; // 動画ページ未生成。次の observe で再試行する

  // 前のバーが YouTube の再描画で外されていることがある。参照だけ差し替えると
  // rAF とリスナを抱えた古いインスタンスが解放されないまま残る
  const previousBar = rangeBar;
  // buildBar が rangeBar を新しいインスタンスに差し替える
  const bar = buildBar();
  previousBar?.destroy();

  // 先頭に入れてプレイヤーのすぐ下に置く。タイトルより下だと、操作するたびに
  // 画面をスクロールして動画と往復することになる
  anchor.insertBefore(bar, anchor.firstChild);

  // 作り直したバーは空で無効の状態。確定済みの範囲があれば載せ直す
  rangeBar?.setEnabled(canAdjustRange());
  if (currentRange !== null) {
    try {
      rangeBar?.update(currentRange, getVideo().duration);
      setStatus(rangeLabel(currentRange));
    } catch (error) {
      // 表示を戻せないだけで、範囲そのものは service worker が持っている
      console.warn(`拡大バーを復元できませんでした: ${String(error)}`);
    }
  }
  refreshOverlay();
}

/**
 * service worker からの指示を受ける。
 *
 * **自分が扱う型には必ず同期で `sendResponse()` を返すこと。** 応答しないと
 * 送り手の Promise は `The message port closed before a response was received.`
 * で reject し、受け取って処理したことが「タブが居ない」と区別できなくなる。
 *
 * **`return true` にして非同期で応答してはいけない。** 送り手 (router) は
 * 直列 queue の中で応答を待つため、応答が遅れると以降のメッセージが 1 つも
 * 処理されなくなり、拡張を再読み込みするまで復帰できない。
 */
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === "recorder/start") {
    sendResponse();
    void beginRecording();
    return;
  }
  if (message.type === "recorder/stop") {
    sendResponse();
    void finishRecording();
    return;
  }
  if (message.type !== "state/changed") return;
  sendResponse();

  const state = message.state;
  applyStateToDisplay(state);

  // ready を離れたら範囲再生の監視は用済み。残すと、旧 OUT 位置を通過した
  // ときに録画中の再生を止めてしまい、新しい OUT へ到達できなくなる
  if (state.kind !== "ready") {
    cancelPreviewWatch();
  }

  // 録画の進行から離れた状態では、走っている監視と録画を始末する。
  // recording は自分で監視を張り直し、encoding では finishRecording が
  // handle を使うので、その 2 つだけは触らない
  if (state.kind !== "recording" && state.kind !== "encoding") {
    cancelWatch?.();
    cancelWatch = null;
    abortRecording();
  }

  if (state.kind === "seeking") {
    void prepareRecording(state.range.startSec, state.meta.videoId);
    return;
  }
  if (state.kind === "recording") {
    void runRecording(state.range.startSec, state.range.endSec);
  }
});

/**
 * 読み込み時に状態機械へ知らせ、返ってきた状態に画面を合わせる。
 *
 * 録画中にタブをリロードすると、OUT を監視していた content script ごと消える。
 * タブは生きているため `tabs.onRemoved` は発火せず、`OUT_REACHED` が永久に
 * 来ないまま service worker は `recording` で固まる。**録画対象のタブだったか
 * どうかは送り主の tabId を持つ service worker にしか判定できない**ので、
 * こちらは読み込まれたことを伝えるだけにして、録画を打ち切るかどうかは
 * router に委ねる (別の YouTube タブを開いただけで録画を落とさないため)。
 *
 * 打ち切られなかった場合は、応答に載ってくる状態で範囲と帯を復元する。
 * service worker は遷移したときにしか通知しないので、読み込み直した
 * content script はこれを送らない限り状態を 1 度も受け取れない。
 */
function recoverFromState(): void {
  void chrome.runtime
    .sendMessage({ type: "content/loaded" } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (response === undefined) {
        setStatus("拡張から応答がありませんでした");
        return;
      }
      applyStateToDisplay(response.state);
      if (currentRange !== null) {
        setStatus(rangeLabel(currentRange));
      }
    })
    .catch((error: unknown) => {
      // 拡張の再読み込み直後などは受け手が居ない。状態を取り戻せないだけで、
      // 次の state/changed で追いつくため、ここで操作を止める必要はない
      console.warn(`状態を取得できませんでした: ${String(error)}`);
    });
}

/** 直前に見ていた URL。SPA 遷移の検出に使う */
let lastHref = location.href;

// YouTube は SPA 遷移するため DOM 変化を監視して再マウントする
const observer = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    // 別の動画へ移ったら、範囲も帯もこの画面のものではなくなる。帯を残すと
    // 旧動画の位置に青い帯が出たままになり、ハンドルを動かせてしまうと
    // 見えていない動画の範囲を書き換えることになる
    rangeBar?.setEnabled(canAdjustRange());
    refreshOverlay();
  }
  mount();
});
observer.observe(document.body, { childList: true, subtree: true });
mount();
recoverFromState();
