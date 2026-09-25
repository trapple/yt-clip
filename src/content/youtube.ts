import { pickMimeType } from "@/content/codec";
import {
  ElementNotFoundError,
  getChannel,
  getVideo,
  getVideoMeta,
  isAdPlaying,
  onReachTime,
  parseVideoId,
  seekTo,
  startPlayback,
  waitForFreshFrame,
  assertFrameCallbackSupported,
  FrameCallbackUnsupportedError,
} from "@/content/player";
import {
  ACTION_EVENTS,
  ACTION_LABELS,
  PRIMARY_ACTIONS,
  actionsFor,
  type BarAction,
} from "@/content/actions";
import { createRangeBar, type RangeBar } from "@/content/range-bar";
import { createSettingsPanel, type SettingsPanel } from "@/content/settings-panel";
import { BAR_STYLE, applyPalette, isDarkTheme } from "@/content/styles";
import { fixVideoDisplayMatrix } from "@/content/display-matrix";
import { makeDefaultRange } from "@/content/range-math";
import {
  DrmProtectedError,
  assertRecordable,
  startRecording,
  type RecorderHandle,
} from "@/content/recorder";
import { createSegmentList, type SegmentList } from "@/content/segment-list";
import { createDockManager } from "@/content/dock";
import {
  createFloatingWindow,
  type DragPoint,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import {
  PANEL_HEADER_HEIGHT_PX,
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
} from "@/content/panel-window";
import { createTelopList, type TelopList } from "@/content/telop-list";
import { createTelopPreview } from "@/content/telop-preview";
import { createTelopTrack, type TelopTrack } from "@/content/telop-track";
import { YT_SELECTORS } from "@/content/selectors";
import {
  TelopRenderError,
  assertTelopRenderable,
  startCompositor,
  type Compositor,
} from "@/content/telop-compositor";
import {
  WINDOW_IDS,
  WINDOW_LAYOUT_VERSION,
  acceptsDock,
  initialBarRect,
  initialDocks,
  loadWindowLayout,
  saveWindowLayout,
  type DockSlotId,
  type WindowId,
  type WindowLayout,
} from "@/content/window-layout";
import { encodeBase64 } from "@/shared/base64";
import type { Message, MessageResponse } from "@/shared/messages";
import {
  loadSettings,
  mergeSettings,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  type ClipMode,
  type Settings,
  type SettingsContext,
} from "@/shared/settings";
import { MAX_TELOP_TEXT_LENGTH, hasRenderableTelops } from "@/shared/telop";
import { telopStyleOf, type TelopStyle } from "@/shared/telop-style";
import { DEFAULT_MAX_CLIP_SEC, formatTime, validateRange } from "@/shared/time";
import { isOverLimit, totalSec } from "@/shared/timeline";
// BUSY_KINDS は状態の性質なので types.ts で共有している
import {
  BUSY_KINDS,
  FAILURE_MESSAGES,
  type ClipEvent,
  type ClipRange,
  type ClipState,
  type Telop,
} from "@/shared/types";

const BAR_ID = "yt-clip-bar";
/** 拡大バーの要素。位置ではなく id で辿れるようにする */
const ACTIONS_ID = `${BAR_ID}-actions`;
const RANGE_ID = "yt-clip-range";
const OVERLAY_ID = "yt-clip-overlay";
/** バーの窓の枠。中身の根 (BAR_ID) はこの中に入れる */
const BAR_WINDOW_ID = "yt-clip-bar-window";
/** バーの窓の最小の幅 (spec A.1)。これより狭いと拡大バーの精度が出ず、操作の行も折り返す */
const BAR_MIN_WIDTH_PX = 480;
/**
 * 区間・テロップの窓と設定の窓の枠 (窓の分割の spec C1.1)。中身の箱は `${id}-body`
 * (panel-window.ts)。E2E と screenshots.mjs もこの id で探す
 */
const LIST_WINDOW_ID = "yt-clip-list";
const SETTINGS_WINDOW_ID = "yt-clip-settings";
/**
 * 窓の見出しの文言 = ドック枠のタブの文言 (窓の分割の spec C1.1)。バーは見出しの行を作らないので、タブだけの文言
 */
const WINDOW_TITLES: Record<WindowId, string> = {
  bar: "バー",
  list: "区間・テロップ",
  settings: "設定",
};

/**
 * 録画品質は再生解像度が上限になるため、低いときは事前に知らせる。
 * `captureStream()` が返すのはデコード済みのフレームなので、解像度は
 * 再生中の画質そのものになる。360p で再生していれば 360p で録れる。
 */
const MIN_RECOMMENDED_HEIGHT = 720;

/**
 * いま画面に出ている区間列。**状態機械が正で、これはその写し。**
 * シンプルモードでは常に 0 個か 1 個
 */
let currentSegments: ClipRange[] = [];
/**
 * いま画面に出ているテロップ。**状態機械が正で、これはその写し。**
 * 別の動画を見ているタブでは空 (区間と同じ規則)
 */
let currentTelops: Telop[] = [];
/** テロップの見た目。設定から組み立てる */
let telopStyle: TelopStyle = telopStyleOf(DEFAULT_SETTINGS);
/**
 * 録画するテロップと見た目。**録画開始時に固定する。** 録画中に ⚙ で見た目を
 * 変えても、途中で見た目が変わるクリップを作らない。null なら今の経路で録る
 */
let recordingTelops: { telops: Telop[]; style: TelopStyle } | null = null;
/**
 * 拡大バーがいま編集している区間の位置。区間が無ければ -1。
 *
 * **ここが選択の唯一の持ち主。** 一覧にも持たせると同期が要る。
 * 並べ替えもマージもしないので index は動かず、数が変わったときだけ詰める
 */
let selectedIndex = -1;
/** 切り抜きの作り方。設定から読む */
let mode: ClipMode = "simple";
let segmentList: SegmentList | null = null;
let telopList: TelopList | null = null;
/** プレイヤーの上のテロップ。バーを作り直しても使い回す (video に付いているため) */
const telopPreview = createTelopPreview();
/**
 * 覚えた位置 (chrome.storage.local) の読み込みが済んだか。**済むまで 3 つの窓を出さない**
 * (spec A.2)。最初の位置に出してから覚えた位置へ跳ぶ絵にしない。読めなかったときも済んだ
 * 扱いにする (最初の位置で出す。出さないままにしない)
 */
let layoutReady = false;
/**
 * フロートで置いた窓の位置と大きさの写し (覚えた配置の `float`。窓の分割の spec C1.3)。
 *
 * **書き換えるのは 3 箇所だけ**: 読み込み (`loadInitialLayout`) / ユーザーが動かした・大きさを変えた
 * (`rememberWindowRect`) / 掴む場所のダブルクリックで戻した (`resetWindow`)。**窓の `rect()` からは作らない。**
 * rect() は画面に詰めた後の位置で、別の窓を動かしただけで、動かしていない窓 (覚えた位置が無いはず) や
 * 詰められた窓 (ブラウザを大きく戻すと置いた場所へ戻るはず) の覚えた位置を書き換えてしまう
 * (floating-window.ts の requested と current の区別を壊す)。
 *
 * **ここに無い窓が「動かしていない窓」。** resize とプレイヤーの大きさの変化で最初の位置を取り直す
 * (spec A.2)。ここにある窓は置いた場所から動かさない。
 *
 * 保存はこの写しから組ごと書く (読み直さない)。そのため**別のタブで後から動かした窓の位置は、このタブで次に
 * 保存すると消える** (最後に動かしたタブの配置が残る。README の制約に書いてある)
 */
const floatLayout: Partial<Record<WindowId, WindowRect>> = {};
/**
 * 区間・テロップの窓。区間の一覧とテロップの一覧を入れる (窓の分割の spec C1.1)。
 *
 * **1 つを使い回す。** 窓の位置を持つので、バーを作り直すたびに作り直さない。中身の入れ替えは
 * `buildBar`、body への付け直しは `mount`、出すかの判定は `refreshWindows` が行う
 */
const listWindow = createPanelWindow({
  id: LIST_WINDOW_ID,
  title: WINDOW_TITLES.list,
  onUserMove: (rect) => rememberWindowRect("list", rect),
  onResetRequest: () => resetWindow("list"),
  // 見出しのドラッグの落とし先の当たり判定 (C2.3)。枠に引き取られたら onUserMove は来ない
  onDragPoint: (phase, point) => dockManager.drag("list", phase, point) !== null,
});
// 窓は body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
applyPalette(listWindow.element, isDarkTheme());
/**
 * 設定の窓。設定パネル (`settings-panel.ts`) を入れ、⚙ で開閉する (C1.2)。**閉じるボタン (×) は
 * 置かない** (右側パネルの spec で不採用にしたのと同じ。閉じ方を ⚙ の 1 つにする)。使い回すのは
 * 区間・テロップの窓と同じ理由
 */
const settingsWindow = createPanelWindow({
  id: SETTINGS_WINDOW_ID,
  title: WINDOW_TITLES.settings,
  onUserMove: (rect) => rememberWindowRect("settings", rect),
  onResetRequest: () => resetWindow("settings"),
  onDragPoint: (phase, point) => dockManager.drag("settings", phase, point) !== null,
});
applyPalette(settingsWindow.element, isDarkTheme());
/**
 * バーの窓。拡大バーと操作の行 (中身の根 #yt-clip-bar) を入れる。
 *
 * **1 つを使い回す** (spec A.3)。モードを変えてバーを作り直しても窓は作り直さないので、
 * 位置と大きさは変わらない。見出しの行は作らず、操作の行の左端のつまみ (⠿) で動かす
 * (見出しの行ぶん高くなると、1440x795 でプレイヤーの下端を覆うため。spec A.1)
 */
const barWindow = createFloatingWindow({
  id: BAR_WINDOW_ID,
  resize: "width",
  minWidth: BAR_MIN_WIDTH_PX,
  onUserMove: (rect) => rememberWindowRect("bar", rect),
  onResetRequest: () => resetWindow("bar"),
  onDragPoint: (phase, point) => dockManager.drag("bar", phase, point) !== null,
  // 枠に入ったバーは ⠿ を 8px 動かすと引き出す (バーだけの枠にはタブが無く、⠿ が唯一の掴む場所。C2.4)
  onUndockRequest: (point, grab) => {
    dockManager.undock("bar");
    placeUnderPointer("bar", point, grab);
  },
});
// バーの窓も body の直下にあり、ページの配色は継がれない
applyPalette(barWindow.element, isDarkTheme());
/**
 * ページの中のドック枠 2 か所 (プレイヤーの下・おすすめ動画の上) とタブ (窓の分割の spec C2)。
 * **枠の中だけを持つ**: 窓を出す条件は refreshWindows、浮いた窓の位置は placeInitial / placeUnderPointer が決める
 */
const dockManager = createDockManager({
  windows: { bar: barWindow, list: listWindow.frame, settings: settingsWindow.frame },
  titles: WINDOW_TITLES,
  // 最初の配置 (ドック。window-layout.ts の INITIAL_DOCKS)。ダブルクリックの戻し先
  initial: initialDocks(),
  accepts: acceptsDock,
  // タブから引き出した窓を指の下に置く。バーはタブの中の位置ではなく ⠿ の位置で置く (C2.4)
  onUndock: (id, point, grab) => placeUnderPointer(id, point, id === "bar" ? null : grab),
  onTabDoubleClick: (id) => resetWindow(id),
  onEvacuate: (id) => placeInitial(id),
  onChange: () => persistWindowLayout(),
});
// 枠は #below / #secondary-inner の中にあるが、YouTube の CSS 変数には頼らない (配色は自前で持つ)
for (const slot of Object.values(dockManager.elements)) applyPalette(slot, isDarkTheme());
/** 設定パネル。⚙ の開閉と、設定の窓を出すかの判定の両方が読む。`buildBar` が作る */
let settingsPanel: SettingsPanel | null = null;
/**
 * 状態機械から最後に届いた種類。
 *
 * モードを切り替えてよいかの判定に使う。`busy` だけでは、録画済みクリップを
 * 抱えた `preview` / `posted` / `degraded` を見分けられない
 */
let lastKind: ClipState["kind"] = "idle";
/**
 * 適用を待っているモード。
 *
 * **`chrome.storage.onChanged` は次に設定を保存するまで来ない。** 切り替えを
 * その場で捨てると、設定はエディットなのにタブはシンプルのまま、開き直すまで
 * 直らない。落ち着いた時点で適用できるよう覚えておく
 */
let pendingMode: ClipMode | null = null;
/**
 * 次に状態が届いたとき、末尾の区間を選ぶ。
 *
 * 区間を足した直後は**足した区間**を選ぶ。前の区間が選ばれたままだと、
 * 「IN → OUT」の癖で OUT を押したときに前の区間の終端が動いて事故になる。
 * 足した区間は必ず末尾に来る (並べ替えないため)
 */
let selectLastOnNextState = false;
/**
 * 次に状態が届いたとき、テロップの一覧の末尾の行を区間・テロップの窓の見える範囲に入れる。
 *
 * `selectLastOnNextState` と同じ形。**クリックの時点では行がまだ無い** (状態機械の
 * 答えを待って描く) ので、応答を描いた後に 1 回だけ送る
 */
let revealLastTelopOnNextState = false;
/**
 * 次に状態が届いたとき、この位置が消えたものとして選択を詰める。
 *
 * 選択より前が消えると、選んでいた区間は 1 つ手前へ移る。位置を覚えずに
 * 「範囲外なら末尾」だけで詰めると、別の区間を選んだまま IN/OUT を押すことになる
 */
let removedIndexOnNextState: number | null = null;
/** 範囲を作ったときの動画。SPA で動画が変わったら無効になる */
let rangeVideoId: string | null = null;
let busy = false;
/** 範囲を変更してよい状態か。状態機械が ready のときだけ真 */
let rangeEditable = false;
let cancelWatch: (() => void) | null = null;
let cancelPreview: (() => void) | null = null;
let rangeBar: RangeBar | null = null;
/**
 * 拡大バーの下のテロップの帯の段 (フロートの窓の spec B)。拡大バーと同じ時間の軸で描くので、
 * 拡大バーと一緒に buildBar が作り直す
 */
let telopTrack: TelopTrack | null = null;
/** 再生位置の監視を張ったか。mount は DOM 変化のたびに呼ばれる */
let playheadWatched = false;
/**
 * 1 クリップの最大長 (秒)。設定から読む。
 *
 * **読む場所が 3 つある** (`makeDefaultRange` / `validateRange` / 拡大バーの
 * `clampHandle`) ので、必ずこの 1 つの変数から配ること。ばらばらに読むと、
 * ドラッグでは伸ばせるのに OUT では弾かれる食い違いが生まれる。
 * 拡大バーへは値を渡さず引かせる (流し込み忘れが起きないようにするため)
 */
let maxClipSec = DEFAULT_MAX_CLIP_SEC;
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
    // 1 行に省略して出すので、全文はマウスを乗せたときに読めるようにする
    status.title = text;
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

/** 拡大バーが編集している区間。無ければ null */
function selectedSegment(): ClipRange | null {
  return currentSegments[selectedIndex] ?? null;
}

/**
 * 状態機械が持つ先頭の区間が、送った範囲と一致するか。
 *
 * シンプルモードの確定待ちに使う。エディットでは並べ替えとマージで結果が
 * 変わるため、そもそも確定を待たない (`onMarkIn` 参照)
 */
function firstMatches(segments: ClipRange[], range: ClipRange): boolean {
  const first = segments[0];
  return first !== undefined && sameRange(first, range);
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

  // **シンプルモードの楽観描画専用。** `currentSegments` を 1 つに倒して
  // `selectedIndex` を 0 にするので、エディットからは呼ばない
  currentSegments = [range];
  selectedIndex = 0;
  paintRangeBar(range, videoDurationSec);
  paintOverlay(currentSegments, videoDurationSec);
  setStatus(rangeLabel(range));
}

/**
 * IN ボタン。モードで意味が変わる。
 *
 * - シンプル: 範囲を作り直す (`MARK_IN`)
 * - エディット: **選択中の区間の頭だけ**を今の位置に動かす (`onMarkSegmentStart`)
 *
 * **エディットで IN を「区間を追加」に置き換えない。** OUT があるのに IN が
 * 無い状態になり、一度作った区間の頭を詰められなくなる。
 */
function onMarkIn(): void {
  if (mode === "edit") {
    onMarkSegmentStart();
    return;
  }

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
  const range = makeDefaultRange(video.currentTime, video.duration, maxClipSec);

  rangeVideoId = meta.videoId;
  applyRange(range, video.duration);
  send(
    { type: "MARK_IN", range, meta },
    (state) => state.kind === "ready" && firstMatches(state.segments, range),
  );
}

/**
 * 選択だけを画面に反映する。状態機械には何も送らない。
 *
 * 選び直しは状態の変化ではないので、`send` を通すと往復のぶん反応が遅れる
 */
function applyStateToSelection(): void {
  // 一覧に何を出すかの規則は `listedItems` の 1 箇所にまとめる (別の動画では空、など)
  segmentList?.update(listedItems().segments, selectedIndex, maxClipSec);

  const segment = selectedSegment();
  if (segment === null) return;
  try {
    paintRangeBar(segment, getVideo().duration);
    setStatus(rangeLabel(segment));
  } catch (error) {
    // 選択は変わっている。拡大バーを描けないことは操作を止める理由にならない
    console.warn(`拡大バーを選択に合わせられませんでした: ${String(error)}`);
  }
}

/**
 * モードの変更を取り込む。
 *
 * **作りかけの区間は全部消す。** エディット (2 区間) からシンプルへ戻したとき、
 * 先頭だけ残すような半端な引き継ぎは何が消えたのか分からない。設定パネルの
 * 説明にも「モードを変えると作りかけの区間は消えます」と書いてある。
 *
 * **録画中は変えない。** 状態機械だけが戻り、録画が走り続けて取り残される。
 * 設定は既に保存されているので、録画が終われば次の変更通知で追いつく
 */
function applyMode(next: ClipMode): void {
  if (next === mode) {
    pendingMode = null;
    return;
  }

  // **区間を捨ててよいのは、まだ何も録れていないときだけ。** 録画中に変えると
  // 状態機械だけが idle へ戻って録画が取り残され、録画済みクリップを持つ状態
  // (preview / posted / degraded) で変えると、実時間を払った成果物への参照ごと
  // 失う。捨てられる状態になるまで待つ
  if (lastKind !== "idle" && lastKind !== "ready") {
    pendingMode = next;
    setStatus("いまは切り替えられません。録画や投稿が済んでから切り替えます");
    return;
  }

  pendingMode = null;
  mode = next;
  // 作り直す前に開いていたかを覚えておく。バーを作り直すと設定パネルも
  // 新しい隠れたものに替わるので、覚えておかないとモードを変えた瞬間に
  // 設定 (設定の窓ごと) が消える。1 つの設定の窓を使い回す設計に
  // なったので、開いたままにする
  const settingsWasOpen = settingsPanel?.element.hidden === false;
  // バーごと作り直してラベルと並びを入れ替える。部分的に差し替えるより、
  // 一度で作り直す方が「どちらのモードの見た目が残っているか」を考えずに済む
  document.getElementById(BAR_ID)?.remove();
  mount();
  // 開いていたなら、⚙ と同じ経路 (開く → refreshWindows → 前に出す)
  // で新しい設定パネルを開き直す。保存済みの値は toggle の fill が入れ直すので、
  // 未保存の入力は失われてよい (モード変更は設定の保存を経由するため保存済み)
  // **新しい隠れた設定パネルがあるときだけ開く。** onToggleSettings は toggle なので、
  // mount() がバーを作り直さなかった場合 (#below が無い) に呼ぶと、開いたままの
  // 古い設定パネルを逆に閉じてしまう
  if (settingsWasOpen && settingsPanel?.element.hidden === true) onToggleSettings();

  if (currentSegments.length > 0) {
    send({ type: "RESET_MARKS" });
  }
}

/**
 * 「＋ 区間を追加」。今の再生位置から新しい区間を作る。
 *
 * **楽観的に描かない。** 並べ替えとマージで結果が変わるので、状態機械の答えを
 * 待ってから描く (`applyStateToDisplay` が反映する)
 */
function onAddSegment(): void {
  if (busy) {
    setStatus("録画中は区間を変更できません");
    return;
  }

  const video = getVideo();
  const meta = getVideoMeta();
  // 既定の長さの区間をここで作る。状態機械は長さの決め方を知らない
  const range = makeDefaultRange(video.currentTime, video.duration, maxClipSec);

  rangeVideoId = meta.videoId;
  // 足した区間を選ぶ。前の区間が選ばれたままだと、続けて IN/OUT を押したとき
  // 別の区間が動く
  selectLastOnNextState = true;
  send({ type: "ADD_SEGMENT", range, meta });
}

/** テロップを出す既定の長さ (秒) */
const DEFAULT_TELOP_SEC = 3;

/**
 * テロップを編集してよいか。区間の拡大バーと同じ条件 (`ready` / `posted` で、
 * 範囲を作った動画を見ている)。**区間は触れないのにテロップだけ触れる非対称を作らない**
 */
function canEditTelops(): boolean {
  return canAdjustRange();
}

/** ＋ テロップ。今の位置から 3 秒、文言なし。動画の長さを超えるなら終わりを詰める */
function onAddTelop(): void {
  if (!canEditTelops()) {
    setStatus("いまはテロップを変更できません");
    return;
  }
  const video = getVideo();
  // メタデータを読む前は duration が NaN。そのまま足すと状態機械が throw する
  if (!Number.isFinite(video.duration)) {
    setStatus("動画の長さが分からないため、テロップを足せません");
    return;
  }
  const startSec = video.currentTime;
  const endSec = Math.min(startSec + DEFAULT_TELOP_SEC, video.duration);
  if (endSec <= startSec) {
    setStatus("動画の終わりにはテロップを足せません");
    return;
  }
  // 足した行を区間・テロップの窓の見える範囲に入れる (右側パネルの spec §3)
  revealLastTelopOnNextState = true;
  send({ type: "ADD_TELOP", telop: { startSec, endSec, text: "" } });
}

/**
 * テロップの開始か終了を今の位置に合わせる。
 *
 * **開始が終了以上になる操作は送らない。** 状態機械は不正な時刻で throw する。
 * 黙って無反応にせず理由を出す
 */
function onMoveTelopEdge(index: number, edge: "start" | "end"): void {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return;
  const sec = getVideo().currentTime;
  const next =
    edge === "start" ? { ...telop, startSec: sec } : { ...telop, endSec: sec };
  if (next.endSec <= next.startSec) {
    setStatus("開始は終了より前にしてください");
    return;
  }
  send({ type: "UPDATE_TELOP", index, telop: next });
}

/** 文言の確定。改行はそのまま持つ */
function onTelopText(index: number, text: string): void {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return;
  if (telop.text === text) return;
  // 状態機械は上限を超えた文言を UI のバグとして拒む。送る前に止めて理由を出す。
  // 入力欄は消さない (削って直してもらう)
  if (text.length > MAX_TELOP_TEXT_LENGTH) {
    setStatus(
      `テロップは ${MAX_TELOP_TEXT_LENGTH} 文字までです (いま ${text.length} 文字)`,
    );
    return;
  }
  send({ type: "UPDATE_TELOP", index, telop: { ...telop, text } });
}

/** そのテロップの頭から再生する。範囲再生の監視は解く (押した場所からの再生が止まる) */
async function playTelop(index: number): Promise<void> {
  const telop = currentTelops[index];
  if (telop === undefined || busy) return;
  cancelPreviewWatch();
  if ((await seekAndPlay(telop.startSec)) === null) return;
  setStatus(`テロップ ${index + 1} の頭から再生中…`);
}

/**
 * 帯のドラッグが確定した (フロートの窓の spec B.2)。帯の段は指を離したときに 1 回だけ、時刻が
 * 変わったときだけ呼ぶ。
 *
 * **応答の状態で受理を確かめる。** 帯は動かした場所に楽観的に描かれているので、拒まれたまま
 * にすると画面と状態が食い違う。拒まれたら正の状態で描き直す (`send` の作法)。テロップは並べ
 * 替えもマージもしないので、受理されれば送った時刻がそのまま載る
 */
function onTelopDragged(index: number, startSec: number, endSec: number): void {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return;
  if (telop.startSec === startSec && telop.endSec === endSec) return;
  send(
    { type: "UPDATE_TELOP", index, telop: { ...telop, startSec, endSec } },
    (state) =>
      "telops" in state &&
      state.telops[index]?.startSec === startSec &&
      state.telops[index]?.endSec === endSec,
  );
}

/**
 * エディットモードの IN。選択中の区間の**頭だけ**を今の位置に動かす。
 *
 * **専用イベントを持たない。** `ADJUST_SEGMENT` (拡大バーのドラッグと同じ) が
 * 既に「この区間をこの範囲にする」を表せているので、同じことをする経路を
 * 2 本持つ理由がない
 */
function onMarkSegmentStart(): void {
  if (busy) {
    setStatus("録画中は区間を変更できません");
    return;
  }

  const editing = selectedSegment();
  if (editing === null) {
    setStatus("先に区間を追加してください");
    return;
  }
  if (getVideoMeta().videoId !== rangeVideoId) {
    setStatus(FAILURE_MESSAGES["video-changed"]);
    return;
  }

  const video = getVideo();
  const next = { startSec: video.currentTime, endSec: editing.endSec };
  const validation = validateRange(next.startSec, next.endSec, maxClipSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }

  // 並べ替えないので、頭を動かしても選択はその場に留まる
  send({ type: "ADJUST_SEGMENT", index: selectedIndex, range: next });
}

function onMarkOut(): void {
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }
  const editing = selectedSegment();
  if (editing === null) {
    setStatus(
      mode === "edit" ? "先に区間を追加してください" : "先に IN を指定してください",
    );
    return;
  }

  // IN を打った後に別の動画へ移動していた場合、その区間はもう意味を持たない。
  // **ここで RESET_MARKS を送らない。** この画面の表示を畳むだけで足り、
  // 状態機械が持っている区間とクリップまで捨てる理由がない (別のタブで
  // 元の動画を開いていれば、そちらでは今も使える)
  if (getVideoMeta().videoId !== rangeVideoId) {
    currentSegments = [];
    selectedIndex = -1;
    rangeVideoId = null;
    clearOverlay();
    // 同じ状況を指す文言は 1 つにする (失敗として届く場合と同じ言い回し)
    setStatus(FAILURE_MESSAGES["video-changed"]);
    return;
  }

  const video = getVideo();
  const next = { startSec: editing.startSec, endSec: video.currentTime };
  const validation = validateRange(next.startSec, next.endSec, maxClipSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }

  // **`applyRange` より先に index を取る。** `applyRange` は単一区間の
  // 楽観描画なので `selectedIndex` を 0 に倒す。後で読むと、2 番目の区間を
  // 選んで OUT を押しても先頭区間が伸び、全区間がマージされて溶ける
  const index = selectedIndex;

  // エディットでは楽観的に描かない。並べ替えとマージで結果が変わるので、
  // 状態機械の答えを待ってから描く (`onMarkIn` と同じ理由)
  if (mode === "edit") {
    send({ type: "MARK_OUT", index, sec: next.endSec });
    return;
  }

  applyRange(next, video.duration);
  send(
    { type: "MARK_OUT", index, sec: next.endSec },
    (state) => state.kind === "ready" && firstMatches(state.segments, next),
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

    currentSegments = currentSegments.map((segment, index) =>
      index === selectedIndex ? range : segment,
    );
    paintOverlay(currentSegments, durationSec);
    setStatus(rangeLabel(range));
    send(
      { type: "ADJUST_SEGMENT", index: selectedIndex, range },
      mode === "edit"
        ? undefined
        : (state) =>
            state.kind === "ready" && firstMatches(state.segments, range),
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

/**
 * 拡大バーのトラックを押されたとき。その位置から再生する。
 *
 * **範囲は変えない。** 切り抜く場所を決める操作ではなく、内容を見るための操作。
 *
 * 範囲再生の監視はここで解く。残すと、登録したときの OUT を通過した瞬間に
 * `pause()` が飛び、押した場所からの再生が理由もなく止まる
 */
async function onSeekPlay(sec: number): Promise<void> {
  cancelPreviewWatch();
  if ((await seekAndPlay(sec)) === null) return;
  setStatus(`${formatTime(sec)} から再生中…`);
}

/**
 * その位置へ飛んで再生する。成功したら動画を返し、失敗したらバーに理由を出す。
 *
 * seek と再生を分けてあるのは player.ts 側の事情 (録画の冒頭が欠けるため)。
 * その手順はここ 1 箇所に置く
 */
async function seekAndPlay(sec: number): Promise<HTMLVideoElement | null> {
  try {
    // getVideo() を try の外に置くと、同期的な throw が Promise の拒否になり、
    // 呼び出し元の `void ...` で握り潰されてボタンが無反応に見える
    const video = getVideo();
    await seekTo(video, sec);
    await startPlayback(video);
    return video;
  } catch (error) {
    setStatus(`再生できませんでした: ${String(error)}`);
    return null;
  }
}

/** 帯 1 本分のスタイル。区間ごとに同じものを並べる */
const OVERLAY_BAND_STYLE =
  "position:absolute;top:0;bottom:0;background:#3ea6ff;opacity:0.5;pointer-events:none;";

/**
 * YouTube のシークバーに区間を帯で重ねて、動画全体のどこかを示す。
 *
 * **区間ごとに子要素を並べる。** 1 本の帯を伸ばして全区間を覆うと、
 * 間の拾っていない部分まで切り抜くように見える
 */
function paintOverlay(segments: ClipRange[], videoDurationSec: number): void {
  const bar = document.querySelector<HTMLElement>(YT_SELECTORS.progressBar);
  if (bar === null || videoDurationSec <= 0) return;

  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay === null) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      "position:absolute;top:0;bottom:0;left:0;right:0;pointer-events:none;z-index:1;";
    bar.appendChild(overlay);
  }

  overlay.replaceChildren(
    ...segments.map((segment) => {
      const band = document.createElement("div");
      band.style.cssText = OVERLAY_BAND_STYLE;
      band.style.left = `${(segment.startSec / videoDurationSec) * 100}%`;
      band.style.width = `${((segment.endSec - segment.startSec) / videoDurationSec) * 100}%`;
      return band;
    }),
  );
}

/** 帯を取り除く。範囲を失った状態や、別の動画を見ているときに残さない */
function clearOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

/** 帯を今の範囲に合わせ直す。範囲が無い・別の動画を見ているなら消す */
function refreshOverlay(): void {
  if (currentSegments.length === 0 || rangeVideoId !== currentVideoId()) {
    clearOverlay();
    return;
  }
  try {
    paintOverlay(currentSegments, getVideo().duration);
  } catch (error) {
    // 帯は範囲の目安にすぎない。描けないことは録画を止める理由にならない
    console.warn(`範囲の帯を描き直せませんでした: ${String(error)}`);
  }
}

/**
 * プレビューを今のテロップと見た目に合わせる。
 *
 * エディットモードで、範囲を作った動画を見ているときだけ出す。別の動画の
 * テロップを重ねない (帯と同じ規則)
 */
function refreshTelopPreview(): void {
  let video: HTMLVideoElement | null = null;
  try {
    video = getVideo();
  } catch (error) {
    // 動画要素がまだ無いか差し替えの最中は ElementNotFoundError で表れる。
    // それ以外の例外は想定していない不具合なので握り潰さずに投げ直す。
    // 次の状態通知 (applyStateToDisplay)、href が変わったとき (observer の分岐)、
    // バーを付け直したとき (mount) のいずれかで追いつく
    if (!(error instanceof ElementNotFoundError)) throw error;
    video = null;
  }
  const visible = mode === "edit" && rangeVideoId === currentVideoId();
  telopPreview.update(video, visible ? currentTelops : [], telopStyle);
}

/**
 * 状態機械が持つ範囲を画面へ反映する。**食い違ったときは状態機械が正。**
 * 表示だけを扱い、録画そのものには触れない。
 */
/** バーのボタンを 1 箇所で作る。見た目の差は primary だけで表す */
function makeButton(
  label: string,
  primary: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.dataset.primary = primary ? "true" : "false";
  button.style.cssText = primary
    ? BAR_STYLE.primaryButton
    : BAR_STYLE.secondaryButton;
  button.addEventListener("click", guard(onClick));
  return button;
}

/**
 * 状態ごとの操作を描き直す。
 *
 * 押しても状態機械に拒まれるだけの操作は出さない。出して拒むより、
 * 出さない方が「いま何ができるか」がそのまま画面に出る
 */
function renderActions(kind: ClipState["kind"]): void {
  const box = document.getElementById(ACTIONS_ID);
  if (box === null) return;

  box.replaceChildren(
    ...actionsFor(kind).map((action: BarAction) => {
      const button = makeButton(
        ACTION_LABELS[action],
        PRIMARY_ACTIONS.has(action),
        () => {
          send(ACTION_EVENTS[action]);
        },
      );
      // 押しても弾かれるだけの録画は押させない。一覧の合計表示と理由を揃える
      if (action === "record" && isOverLimit(currentSegments, maxClipSec)) {
        button.disabled = true;
        button.title = `合計が上限 ${maxClipSec} 秒を超えています`;
      }
      return button;
    }),
  );
}

/**
 * 一覧に出す区間とテロップ。**エディットモードで、範囲を作った動画を見ているときだけ。**
 *
 * シンプルで使っている人に、関係のない概念を見せない。別の動画の区間は出さない
 * (帯・プレビューと同じ規則)。画面に浮いた窓に出すので、SPA で動画 B へ移ったのに
 * 動画 A の区間が出続けると目立つ (spec §4)
 */
function listedItems(): { segments: ClipRange[]; telops: Telop[] } {
  if (mode !== "edit" || rangeVideoId !== currentVideoId()) {
    return { segments: [], telops: [] };
  }
  return { segments: currentSegments, telops: currentTelops };
}

/** 窓の枠。id で引く (覚えた配置の鍵と同じ名前) */
function windowOf(id: WindowId): FloatingWindow {
  if (id === "bar") return barWindow;
  return id === "list" ? listWindow.frame : settingsWindow.frame;
}

/**
 * 窓の最初の位置 (spec A.2 / C1.3)。バーはプレイヤーの直下、区間・テロップの窓は画面の右上、
 * 設定の窓は区間・テロップの窓の最初の位置から下へ 32px。
 * プレイヤーがまだ無ければ null (出たときに取り直す)。
 *
 * **プレイヤーの画面上の位置をそのまま使う。** ページがスクロールされていても、今見えている
 * 位置の直下に置く (窓は画面に固定なので、ページの座標に直さない)。バーの高さは出ている窓で
 * 測る (隠れている窓は 0 になる。そのため出した直後に取り直す: refreshWindows)
 */
function initialWindowRect(id: WindowId): WindowRect | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (id === "list") return initialListRect(viewport);
  // 区間・テロップの窓の**最初の位置**から下へずらす。一覧を動かしていても、その位置には付いていかない
  if (id === "settings") return initialSettingsRect(viewport);
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === null) return null;
  const box = player.getBoundingClientRect();
  // **高さを測る前にプレイヤーの幅を当てる。** 覚えた位置が無い読み込みでは窓は最小の幅
  // (480px) のままで、エディットモードの操作の行は 2 段に折り返して背が高く測れる。その高さで
  // 画面の下端に詰めると、プレイヤーの直下より上に置かれてシークバーに重なる。
  // place は style を同期で当てるので、直後の測定は新しい幅でレイアウトされる
  barWindow.place({ left: box.left, top: barWindow.rect().top, width: box.width });
  return initialBarRect(
    { left: box.left, bottom: box.bottom, width: box.width },
    barWindow.element.getBoundingClientRect().height,
    viewport,
  );
}

/**
 * 動かしていない窓 (覚えた `float` に無い窓) と、退避中の窓 (入っている枠が使えない間の浮いた窓。C2.1) を
 * 最初の位置に置く。**退避中の窓は `float` に位置があっても最初の位置** (C2.1 / C2.6)。ドック中の窓 (使える枠に
 * 入っている) はページの流れが決めるので置かない。覚えた配置の読み込みが済む前は何もしない (まだ出さない)
 */
function placeInitial(id: WindowId): void {
  if (!layoutReady) return;
  const slot = dockManager.slotOf(id);
  const evacuated = slot !== null && !dockManager.isUsable(slot);
  if (slot !== null && !evacuated) return;
  if (!evacuated && floatLayout[id] !== undefined) return;
  const rect = initialWindowRect(id);
  if (rect !== null) windowOf(id).place(rect);
}

/**
 * 枠から引き出した窓を指の下に置く (C2.4)。幅と高さは覚えた `float`、無ければ最初の位置の大きさ
 * (バーはプレイヤーの幅、区間・テロップの窓と設定の窓は幅 400px・高さは中身)。
 *
 * - バー: ⠿ が指の下に残るよう、窓の左上 = 指 − ⠿ の窓の中の位置。`grab` (⠿ で引き出したとき、押した点の窓の中の
 *   位置) が無ければ (タブから引き出したとき) ⠿ の中心を測る
 * - 区間・テロップの窓と設定の窓: 掴んだタブの位置関係を保つ。窓の左端 = 指 − タブの中で掴んだ x (窓の幅に収める)、
 *   上端 = 指 − 見出しの高さの半分 (指が見出しの中に来る)
 *
 * **`floatLayout` は書き換えない** (書き換えるのは読み込み・onUserMove・ダブルクリックの 3 箇所)。引き出した後の
 * ドラッグの終わりに onUserMove が来て、そこで覚える
 */
function placeUnderPointer(id: WindowId, point: DragPoint, grab: DragPoint | null): void {
  const remembered = floatLayout[id];
  if (id === "bar") {
    const player = document.querySelector(YT_SELECTORS.player);
    const width = remembered?.width ?? player?.getBoundingClientRect().width ?? BAR_MIN_WIDTH_PX;
    // 幅を先に当てる (操作の行の折り返しで ⠿ の位置が変わる)
    barWindow.place({ left: point.x, top: point.y, width });
    const offset = grab ?? barGripCenter();
    barWindow.place({ left: point.x - offset.x, top: point.y - offset.y, width });
    return;
  }
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const width = remembered?.width ?? initialListRect(viewport).width;
  const tabX = Math.min(Math.max(grab?.x ?? 0, 0), width);
  const left = point.x - tabX;
  const top = point.y - PANEL_HEADER_HEIGHT_PX / 2;
  windowOf(id).place(
    remembered?.height === undefined
      ? { left, top, width }
      : { left, top, width, height: remembered.height },
  );
}

/** バーの窓の中の ⠿ の中心 (窓の左上から)。⠿ が無ければ窓の左上 */
function barGripCenter(): DragPoint {
  const grip = document.getElementById(BAR_ID)?.querySelector("[data-role='grip']");
  if (grip == null) return { x: 0, y: 0 };
  const frame = barWindow.element.getBoundingClientRect();
  const box = grip.getBoundingClientRect();
  return { x: box.left - frame.left + box.width / 2, y: box.top - frame.top + box.height / 2 };
}

/** ドック枠を差す先 (C2.1)。右の枠は #secondary-inner、無ければ #secondary */
function dockAnchors(): Record<DockSlotId, Element | null> {
  let side: Element | null = null;
  for (const selector of YT_SELECTORS.dockSide) {
    side = document.querySelector(selector);
    if (side !== null) break;
  }
  return { below: document.querySelector(YT_SELECTORS.dockBelow), side };
}

/**
 * 覚える配置の組を、写し (`floatLayout`) と枠の中身 (`dockManager.state()`) から作る。**窓の `rect()` からは作らない**
 * (floatLayout の doc)。1 つの操作で 2 つの枠が変わりうる (引き出して別の枠へ) ので、いつも組ごと書く (C1.3)
 */
function currentWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: { ...floatLayout }, docks: dockManager.state() };
}

/** 覚える配置を組ごと保存する */
function persistWindowLayout(): void {
  void saveWindowLayout(currentWindowLayout()).catch((error: unknown) => {
    // 覚えられないだけで、今の画面の窓は置いた場所にある。次に開くと前に覚えた配置で出る
    console.warn(`窓の位置を保存できませんでした: ${String(error)}`);
  });
}

/** ユーザーが窓を動かした・大きさを変えた (指を離した時点で 1 回)。次に開いたときも同じ位置に出す */
function rememberWindowRect(id: WindowId, rect: WindowRect): void {
  floatLayout[id] = { ...rect };
  // 退避中 (入っている枠が使えない間の浮いた窓) の窓を動かしたら、その時点で浮いた窓になる (枠の記憶からも外す。
  // C2.1)。外すと onChange で組ごと保存されるので、ここでは保存しない
  if (dockManager.slotOf(id) !== null) {
    dockManager.undock(id);
    return;
  }
  persistWindowLayout();
}

/**
 * 掴む場所 (⠿ / 見出し / タブ) のダブルクリック。**最初の配置 (ドック) の枠へ戻し**、覚えた位置も消す (spec A.2 / C2.6)。
 * 浮いた窓も、別の枠に入れた窓も、最初の配置の枠の最初の配置の並びの位置へ入れて前に出す (dock.ts の restore)。
 * 保存は restore の onChange が組ごと行う (消した float も含む)
 */
function resetWindow(id: WindowId): void {
  // 先に写しから消す。placeInitial は写しにある窓 (動かした窓) を置き直さない
  delete floatLayout[id];
  dockManager.restore(id);
  // 戻す先の枠が使えない (退避) か、最初の配置で枠に入らない窓は、浮いた窓の最初の位置へ置く。ドック中なら何もしない
  placeInitial(id);
}

/**
 * 3 つの窓 (バーの窓・区間・テロップの窓・設定の窓) を出すか隠すかを決める。**`setVisible` を
 * 呼ぶのはここだけ** (右側パネルの spec §4 を 3 つの窓へ広げた。窓の分割の spec C1.2)。
 *
 * どれも隠すのは、覚えた位置を読み込む前 / 全画面 / 動画ページ以外。そのうえで、バーは中身の根
 * (BAR_ID) がある間、区間・テロップの窓は一覧のどちらかが見えている間 (一覧は中身が無いと自分で
 * 隠れる)、設定の窓は ⚙ で開いている間 (設定パネルの `hidden` が偽) だけ出す
 */
function refreshWindows(): void {
  const listShown = [segmentList?.element, telopList?.element].some(
    (part) => part !== undefined && !part.hidden,
  );
  const settingsOpen = settingsPanel?.element.hidden === false;
  // **`!= null` にする。** jsdom は fullscreenElement を持たず undefined を返すので、
  // `!== null` だとテストで常に全画面扱いになる。body 直下の fixed 要素は全画面の
  // 動画の上に残りうるので、全画面では出さない
  const fullscreen = document.fullscreenElement != null;
  const onVideoPage = currentVideoId() !== null;
  // 覚えた位置を読む前に出すと、最初の位置に出てから覚えた位置へ跳ぶ絵になる (spec A.2)
  const canShow = layoutReady && !fullscreen && onVideoPage;

  const barWasHidden = barWindow.element.hidden;
  const listWasHidden = listWindow.element.hidden;
  const settingsWasHidden = settingsWindow.element.hidden;
  barWindow.setVisible(canShow && document.getElementById(BAR_ID) !== null);
  listWindow.setVisible(canShow && listShown);
  settingsWindow.setVisible(canShow && settingsOpen);
  // 出す条件が変わったら、枠のタブ・枠の出し入れ・退避を合わせる (C2.2 / C2.7)。**出した直後の取り直しより先に:**
  // 使えない枠の窓は sync が body へ移して浮かせ (onEvacuate で最初の位置へ)、その後で下の取り直しが効く
  dockManager.sync();
  // 隠れていた窓は寸法が 0 で、最初の位置 (バーの高さで画面の下端に詰める) を測れていない。
  // **出した直後にだけ**取り直す。出ている間に状態が届くたびに取り直すと、ページを
  // スクロールした後に IN を押しただけで、バーがプレイヤーを追って跳ぶ (spec A.2)
  if (barWasHidden && !barWindow.element.hidden) placeInitial("bar");
  if (listWasHidden && !listWindow.element.hidden) placeInitial("list");
  if (settingsWasHidden && !settingsWindow.element.hidden) placeInitial("settings");
}

/**
 * 拡大バーを描き直し、同じ時間の軸で帯の段も描き直す。**拡大バーの窓が変わる経路はここを通す**
 * (帯だけが古い窓のまま残らないように)
 */
function paintRangeBar(range: ClipRange, videoDurationSec: number): void {
  rangeBar?.update(range, videoDurationSec);
  refreshTelopTrack();
}

/**
 * 拡大バーの下のテロップの帯を描き直す (フロートの窓の spec B)。拡大バーを描き直したとき
 * (`paintRangeBar`) と、テロップや出す条件が変わったとき (`refreshLists`) に呼ぶ。
 *
 * 出すテロップは一覧と同じ規則 (`listedItems`: エディットモードで、範囲を作った動画を見ている
 * とき)。拡大バーがまだ窓を持たない (範囲を描く前) ときは渡さない (時間の軸が無い)。
 * 動かせる条件も一覧と同じ (`canEditTelops`)。
 *
 * **1 回の状態通知で 2 回呼ばれうる** (`applyStateToDisplay` が `refreshLists` の後に、拡大バーが
 * ずれていれば `paintRangeBar` も呼ぶ)。同じ入力なら同じ絵になる (冪等) ので、二重呼び出しは不具合ではない
 */
function refreshTelopTrack(): void {
  if (telopTrack === null) return;
  const timeWindow = rangeBar?.window() ?? null;
  const wasHidden = telopTrack.element.hidden;
  telopTrack.setEnabled(canEditTelops());
  telopTrack.update(
    timeWindow === null ? [] : listedItems().telops,
    timeWindow ?? { startSec: 0, endSec: 0 },
  );
  // 段が出る・消えるとバーの窓の高さが 34px 変わる。つまみ (操作の行) が画面の下へ押し出され
  // ないよう、置いた場所から詰め直す。**最初の位置は取り直さない** (取り直すきっかけは resize と
  // プレイヤーの大きさの変化だけ。spec A.2)
  if (wasHidden !== telopTrack.element.hidden) barWindow.refit();
}

/**
 * 一覧と帯の段を手元の写しに合わせて描き直し、窓を出すかを決め直す。
 * 状態の通知・バーの作り直し (`mount`)・SPA 遷移の 3 箇所から呼ぶ
 */
function refreshLists(): void {
  const { segments, telops } = listedItems();
  segmentList?.setEnabled(!busy);
  segmentList?.update(segments, selectedIndex, maxClipSec);
  telopList?.setEnabled(canEditTelops());
  telopList?.update(telops, segments);
  refreshTelopTrack();
  refreshWindows();
}

/**
 * 足した行を区間・テロップの窓の見える範囲に入れる。**応答を描いた後に呼ぶ** (クリックの時点では
 * 行がまだ無い)。押した結果が見えないと無反応に見える (右側パネルの spec §3)。
 *
 * **窓を前には出さない** (C1.2 は窓の中を送ることだけを求める)。前に出すと、設定の窓で値を
 * 見ながら区間を足したときに設定が潜る。窓が隠れている (全画面など) ときは何もしない。
 * 出す判断は `refreshWindows` のもの
 */
function revealLastRow(
  list: HTMLElement | undefined,
  role: "segment" | "telop",
): void {
  if (list === undefined || listWindow.element.hidden) return;
  const rows = list.querySelectorAll<HTMLElement>(`[data-role='${role}']`);
  const last = rows[rows.length - 1];
  if (last === undefined) return;
  listWindow.scrollTo(last);
}

function applyStateToDisplay(state: ClipState): void {
  const stateSegments = "segments" in state ? state.segments : [];
  const stateMeta = "meta" in state ? state.meta : null;
  // idle と failed が持つ範囲は「もう操作できない過去のもの」。画面から消す。
  // failed から RETRY で戻るときは、ready の state/changed が範囲を持ってくる。
  //
  // **別の動画を見ているタブでは取り込まない。** 状態機械の範囲は他の動画の
  // ものなので、覚えてしまうとステータス行に別動画の範囲が出るうえ、
  // 「範囲を再生」でこの動画をその位置へ飛ばしてしまう (canAdjustRange と同じ規則)
  const liveSegments =
    state.kind === "idle" ||
    state.kind === "failed" ||
    stateMeta?.videoId !== currentVideoId()
      ? []
      : stateSegments;

  // **並べ替えとマージで index は動く。** いま触っていた区間の開始秒で
  // 引き直せば、マージで消えた区間を選んでいた場合もマージ先が返るので、
  // 選択が迷子にならない (区間に ID を振らずに済ませる代わりの仕掛け)
  const previous = selectedSegment();

  busy = BUSY_KINDS.has(state.kind);
  // 投稿した後も範囲を触れる。触ると状態機械が ready へ戻し、
  // 古い範囲のクリップは外れる
  rangeEditable = state.kind === "ready" || state.kind === "posted";
  currentSegments = liveSegments;
  const previousTelopCount = currentTelops.length;
  currentTelops =
    liveSegments.length === 0 || !("telops" in state) ? [] : state.telops;
  // 最後の区間の削除は UI で止めているが、手元の写しが古くて止め損ねた場合に
  // 黙って消さない
  // **別の動画の状態では言わない。** 削除の応答待ちの間に別の動画へ移ると、取り込まない
  // ので手元は空になるが、状態機械にはまだ残っている。idle は meta を持たないが、
  // そのときは本当に消えている
  if (
    removedIndexOnNextState !== null &&
    previousTelopCount > 0 &&
    currentTelops.length === 0 &&
    (stateMeta === null || stateMeta.videoId === currentVideoId())
  ) {
    setStatus("テロップも消えました");
  }
  // **並べ替えないので index は動かない。** 足した直後だけ末尾へ移し、
  // それ以外は今の位置を保つ。削除で数が減ったときだけ範囲内へ詰める
  if (liveSegments.length === 0) {
    selectedIndex = -1;
  } else if (selectLastOnNextState || selectedIndex < 0) {
    selectedIndex = liveSegments.length - 1;
  } else {
    // 選択より前が消えたら、選んでいた区間は 1 つ手前へ移っている
    if (
      removedIndexOnNextState !== null &&
      removedIndexOnNextState < selectedIndex
    ) {
      selectedIndex -= 1;
    }
    // 選択そのものが消えたときは、同じ位置に来た区間 (無ければ末尾) を選ぶ
    if (selectedIndex >= liveSegments.length) {
      selectedIndex = liveSegments.length - 1;
    }
  }
  // 足した直後の 1 回だけ、足した行へ送る。描き終えてから送るので、ここでは覚えるだけ
  const revealSegment = selectLastOnNextState;
  const revealTelop = revealLastTelopOnNextState;
  selectLastOnNextState = false;
  revealLastTelopOnNextState = false;
  removedIndexOnNextState = null;

  const current = selectedSegment();
  const drifted =
    previous === null || current === null
      ? previous !== current
      : !sameRange(previous, current);

  // どの動画の範囲かも状態機械が持っている。content script が読み込み
  // 直された後でも、これで取り戻せる
  rangeVideoId = stateMeta?.videoId ?? null;

  rangeBar?.setEnabled(canAdjustRange());
  refreshOverlay();
  refreshTelopPreview();
  renderActions(state.kind);

  // 失敗はバーにも出す。録画中にタブをリロードした場合、このバーが
  // 唯一の手がかりになる (popup を開かない限り理由が分からない)
  if (state.kind === "failed") {
    setStatus(FAILURE_MESSAGES[state.reason]);
  }

  // 拡大バーを描き直すのは、表示がずれているときだけにする。確定のたびに
  // 描き直すと窓が計算し直されてハンドルが跳ねる。
  // ただし録画中は、打ち切られたドラッグの見た目が最後の位置に残るため、
  // ずれていなくても確定済みの範囲で描き直す
  refreshLists();
  // 一覧と窓の表示が決まってから送る (出す → 送る の順)
  if (revealSegment) revealLastRow(segmentList?.element, "segment");
  if (revealTelop) revealLastRow(telopList?.element, "telop");

  lastKind = state.kind;
  // 待たせていた切り替えを拾う。`applyMode` はバーを作り直すので、
  // 画面の更新をひととおり終えてから呼ぶ
  if (pendingMode !== null) {
    applyMode(pendingMode);
  }

  if (current !== null && (drifted || busy)) {
    try {
      paintRangeBar(current, getVideo().duration);
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
  const range = selectedSegment();
  if (range === null || busy) return;

  cancelPreviewWatch();
  const video = await seekAndPlay(range.startSec);
  if (video === null) return;

  try {
    setStatus(`範囲を再生中… (${Math.round(range.endSec - range.startSec)}秒)`);
    cancelPreview = onReachTime(video, range.endSec, () => {
      cancelPreview = null;
      // 登録したときの範囲を今も使っているかを確かめる。解除が漏れていた
      // 場合にここで止めると、別の範囲の再生や録画まで巻き込んで止める
      const still = selectedSegment();
      if (busy || still === null || !sameRange(still, range)) {
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
 * テロップ付きの録画を失敗で落とす。文言は状態機械から返ってくるものと同じ
 * (既定) か、それに詳細を足したもの。違う言い回しを出すと、直後に届く
 * state/changed で表示が言い換わって見える
 */
function failTelopRecording(
  reason: "telop-tab-hidden" | "telop-render-failed",
  message: string = FAILURE_MESSAGES[reason],
): void {
  send({ type: "FAIL", reason });
  setStatus(message);
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
    // 前の準備の残りで合成しない。以下のどの経路で抜けても、録画に使う
    // テロップは下で決め直したものか null になる
    recordingTelops = null;
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

    // **テロップの有無で録画の経路を決め、描けるかをここで確かめる。**
    // `beginRecording` で気付くと、router が理由を問わず recording-aborted に
    // 落とすので専用の文言が出ない。見た目もここで固定する (録画中に変えても効かない)
    if (hasRenderableTelops(currentTelops, currentSegments)) {
      // 隠れたまま始めると、最初のフレームから映像が止まる。**描けるかより先に
      // 見る。** 隠れた窓では動画がデコードされず videoWidth が 0 になり
      // (テロップ spec §9.1)、先に「動画の大きさがまだ分かりません」が出て
      // 本当の理由が伝わらない
      if (document.hidden) {
        failTelopRecording("telop-tab-hidden");
        return;
      }
      assertTelopRenderable(getVideo());
      recordingTelops = { telops: currentTelops, style: telopStyle };
    }

    // **繋ぎ目の検査もここで済ませる。** 区間の間で初めて気付くと、既に
    // 実時間を払った後になる。同期 throw が advanceToSegment の catch に
    // 飲まれて seek-failed に化ける経路も塞げる
    if (currentSegments.length > 1) {
      assertFrameCallbackSupported(getVideo());
    }

    if (isAdPlaying()) {
      send({ type: "FAIL", reason: "ad-playing" });
      setStatus("広告の再生中です。終了後にやり直してください");
      return;
    }

    // **合計で見る。区間ごとではない。** 区間ごとに上限を見ると、10 秒の
    // 区間を 10 個作れてしまい、X の上限を超えたクリップができる
    // **失敗にしない。** 合計を減らせば直せるので、区間を触れる `ready` へ
    // 戻す。`FAIL` だと「内部エラーが発生しました」で上書きされ、何をすれば
    // よいか画面のどこにも出なくなる
    if (isOverLimit(currentSegments, maxClipSec)) {
      const sum = Math.round(totalSec(currentSegments));
      send({ type: "CANCEL_RECORDING" });
      setStatus(`合計 ${sum} 秒は上限 ${maxClipSec} 秒を超えています`);
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
    if (error instanceof TelopRenderError) {
      failTelopRecording("telop-render-failed", error.message);
      return;
    }
    if (error instanceof FrameCallbackUnsupportedError) {
      send({ type: "FAIL", reason: "internal-error" });
      setStatus(error.message);
      return;
    }
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`開始位置へ移動できませんでした: ${String(error)}`);
  }
}

/** service worker からの指示で録画を始める */
async function beginRecording(): Promise<void> {
  // 録画が始まらなかったときに合成を残さないよう、try の外で持つ
  let videoOverride: Compositor | undefined;
  try {
    const video = getVideo();
    const { mimeType } = pickMimeType();
    const telops = recordingTelops;
    // 使い切ったら空にする。seeking を通らずに recorder/start が来たとき
    // (実機の順序の食い違いやテスト) に、前の録画のテロップで合成しない
    recordingTelops = null;
    // prepareRecording の検査は seek の await より前の 1 回だけ。その後の
    // SEEK_DONE → service worker → recorder/start の往復の間にタブが隠れると、
    // startCompositor はここから先の visibilitychange しか見ないので、隠れた
    // まま録り始めると音声だけ進むクリップになる。始める直前にもう一度見る
    if (telops !== null && document.hidden) {
      failTelopRecording("telop-tab-hidden");
      return;
    }
    // 合成は録画の解放 (buildRecordingStream の release) に繋がるので、
    // 録画が自動で止まった経路でも描画ループが残らない
    videoOverride =
      telops === null
        ? undefined
        : startCompositor(video, telops.telops, telops.style, undefined, {
            // 区間の間の広告検査と同じく FAIL で落とす。状態が recording を離れると
            // state/changed の処理が abortRecording を呼び、合成も解放される
            onHidden: () => failTelopRecording("telop-tab-hidden"),
            // 描画が止まった録画を成功として出さない (静止した映像と進む音声になる)
            onError: (error) =>
              failTelopRecording(
                "telop-render-failed",
                new TelopRenderError(error.message).message,
              ),
          });
    handle = await startRecording(video, mimeType, {
      videoOverride,
      onUnexpectedStop: (error) => {
        handle = null;
        notify({ type: "recorder/failed", reason: error.message });
      },
    });
    notify({ type: "recorder/started" });
  } catch (error) {
    // release は二度呼んでも安全 (startRecording の中で解放済みのことがある)
    videoOverride?.release();
    notify({ type: "recorder/failed", reason: String(error) });
  }
}

/**
 * 録画の後半。録画開始後に呼ばれ、区間を順に辿って最後の OUT で停止する。
 *
 * **区間ごとに録画セッションを分けない。** 1 本のセッションを走らせたまま
 * `pause()` / `resume()` で繋げば、出力は継ぎ目のない 1 本になる。分けると
 * MP4 の結合が要る
 */
async function runRecording(segments: ClipRange[]): Promise<void> {
  try {
    const video = getVideo();
    await startPlayback(video);
    watchSegmentEnd(video, segments, 0);
  } catch (error) {
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
  }
}

/** いまの区間の終わりを待つ。次があれば繋ぎ、無ければ書き出しへ進む */
function watchSegmentEnd(
  video: HTMLVideoElement,
  segments: ClipRange[],
  index: number,
): void {
  const segment = segments[index];
  if (segment === undefined) {
    // 状態機械が渡した区間列と辿っている位置が食い違っている。UI のバグ
    send({ type: "FAIL", reason: "internal-error" });
    return;
  }

  const remainingSec = Math.round(totalSec(segments.slice(index)));
  setStatus(
    segments.length === 1
      ? `録画中… (${remainingSec}秒)`
      : `録画中… ${index + 1} / ${segments.length} 区間目 (残り ${remainingSec}秒)`,
  );

  cancelWatch = onReachTime(video, segment.endSec, () => {
    cancelWatch = null;
    if (segments[index + 1] === undefined) {
      video.pause();
      send({ type: "OUT_REACHED" });
      setStatus("録画を書き出しています…");
      return;
    }
    void advanceToSegment(video, segments, index + 1);
  });
}

/**
 * 区間の間。録画を止めて次の頭へ飛び、映像が整ってから再開する。
 *
 * **`seeked` だけで再開しない。** 直後はデコードが追いつかず前のフレームが
 * 残っていることがあり、繋ぎ目に前の場面が数フレーム混入する
 * (`waitForFreshFrame`)。
 */
async function advanceToSegment(
  video: HTMLVideoElement,
  segments: ClipRange[],
  index: number,
): Promise<void> {
  const segment = segments[index];
  if (segment === undefined || handle === null) {
    // handle が無いのに区間を繋ごうとしている = 録画が始まっていない
    send({ type: "FAIL", reason: "internal-error" });
    return;
  }

  const recorder = handle;
  try {
    recorder.pause();
    video.pause();
    setStatus(`${index + 1} / ${segments.length} 区間目へ移動中…`);

    await seekTo(video, segment.startSec);
    await startPlayback(video);
    await waitForFreshFrame(video);

    // **待っている間に録画が捨てられていないか確かめる。** 中止や失敗で
    // `abortRecording` が走ると `handle` は差し替わる。止まった recorder に
    // `resume()` を投げると throw し、`ready` へ戻ったはずの状態が
    // `seek-failed` に落ちる。録り直しで始まった新しい録画を巻き込むこともある
    if (handle !== recorder) return;

    // **区間ごとに広告を見る。** 録画開始前の 1 回だけでは、この間に始まった
    // ミッドロールを拾えない。部分的に広告が混ざったクリップを残すより、
    // 録り直させる方がましである
    if (isAdPlaying()) {
      send({ type: "FAIL", reason: "ad-playing" });
      setStatus(FAILURE_MESSAGES["ad-playing"]);
      return;
    }

    recorder.resume();
    watchSegmentEnd(video, segments, index);
  } catch (error) {
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`${FAILURE_MESSAGES["seek-failed"]}: ${String(error)}`);
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
    const recorded = new Uint8Array(await blob.arrayBuffer());

    // captureStream で録ると、Chromium の muxer が映像トラックの表示行列の
    // 最後の要素を書き忘れる。そのままでは X の変換が落ちるので直す。
    // WebM はそもそも添付できずダウンロードへ退避するので、触らない
    //
    // **ここで失敗しても録画は捨てない。** 録画は実時間のコストを払い終えて
    // おり、壊れているのは飾りの 4 バイトを直す後処理だけ。未修正のまま渡せば
    // X には弾かれるが、ダウンロードで回収する道は残る。Chromium が muxer の
    // box 構成を変えたときに全録画が消える経路にしない
    let bytes = recorded;
    if (blob.type.includes("mp4")) {
      try {
        bytes = fixVideoDisplayMatrix(recorded);
      } catch (error) {
        console.error(
          `表示行列を直せませんでした。X への添付は弾かれる見込みです: ${String(error)}`,
        );
      }
    }

    notify({
      type: "recorder/done",
      base64: encodeBase64(bytes),
      mimeType: blob.type,
    });
  } catch (error) {
    notify({ type: "recorder/failed", reason: String(error) });
  }
}

/**
 * 設定パネルに渡す文脈。**開くたびに読む** (SPA 遷移で別のチャンネルへ移る)。
 *
 * `getChannel` は見つからなくても throw しないので、ここに try/catch は要らない。
 * `buildBar` の中に閉じ込めないのは、同じスコープの他のクロージャが設定パネルを
 * 捕捉しているため、`buildBar` のスコープごと生き残ることになるから
 */
function readChannelContext(): SettingsContext {
  const channel = getChannel();
  // ID が取れないチャンネルは設定の鍵にできない。入力させない
  return { channel: channel.id === "" ? null : channel };
}

/**
 * ⚙。設定の窓を開閉する (窓の分割の spec C1.2)。**開いたら設定の窓を前に出す。** 最初の位置では
 * 区間・テロップの窓に下へ 32px ずれて重なるので、前に出さないと一覧の窓の下に潜り、押しても
 * 開いていないように見える。
 *
 * **開く → 出す → 前に出す の順を崩さない。** 窓を出すかは設定パネルの `hidden` を見て
 * refreshWindows が決める。窓の中は送らない (中身は設定だけで、送る先が無い)
 */
function onToggleSettings(): void {
  // ⚙ は buildBar の中で設定パネルを作った後に作るので、押せた時点で null は
  // ありえない。null なら配線のバグなので、黙って何もしない形で隠さない
  if (settingsPanel === null) {
    throw new Error("設定パネルを作る前に ⚙ が押されました");
  }
  settingsPanel.toggle();
  refreshWindows();
  if (settingsPanel.element.hidden) return;
  settingsWindow.frame.bringToFront();
}

function buildBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText = BAR_STYLE.root;
  // 配色は自前で持つ。YouTube の CSS 変数はここでは解決しない
  applyPalette(bar, isDarkTheme());

  const row = document.createElement("div");
  row.style.cssText = BAR_STYLE.row;

  // 窓を動かすつまみ。**見出しの行は作らない** (バーが高くなるとプレイヤーを覆う。spec A.1)。
  // 操作の行は作り直すたびに新しくなるので、ここで毎回窓に登録し直す (古いつまみは行ごと捨てる)
  const grip = document.createElement("span");
  grip.dataset.role = "grip";
  grip.textContent = "⠿";
  grip.title = "ドラッグで動かす (ダブルクリックで最初の位置へ)";
  grip.style.cssText = BAR_STYLE.grip;
  barWindow.addDragHandle(grip);

  // 常に出ている操作。主操作は状態ごとに変わる側 (renderActions) が持つ
  // **IN は残す。** 置き換えると、一度作った区間の頭を詰められなくなる
  const addButton =
    mode === "edit"
      ? makeButton("＋ 区間を追加", false, onAddSegment)
      : null;
  const inButton = makeButton("IN", false, onMarkIn);
  const outButton = makeButton("OUT", false, onMarkOut);
  const playButton = makeButton(
    mode === "edit" ? "▶ 区間を見る" : "▶ 範囲を見る",
    false,
    () => void playRange(),
  );

  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.style.cssText = BAR_STYLE.status;
  status.textContent = "IN を押して開始位置を指定";
  status.title = status.textContent;

  // 状態ごとに中身を入れ替える箱。押しても拒まれるだけの操作は出さない
  const actions = document.createElement("div");
  actions.id = ACTIONS_ID;
  actions.style.cssText = BAR_STYLE.row;

  const settings = createSettingsPanel({ getContext: readChannelContext });
  settingsPanel = settings;
  // 状態の文言 (flex:1) が残りの幅を取るので、⚙ は右端に来る。操作の並びから
  // 外して、押し間違いを減らす
  const settingsButton = makeButton("⚙", false, onToggleSettings);
  settingsButton.title = "設定";

  // つまみは左端。その後は「追加してから頭と尻を決める」順に並べる
  row.append(grip);
  if (addButton !== null) row.append(addButton);
  row.append(inButton, outButton, playButton, actions, status, settingsButton);

  // 拡大バーは生成直後は無効。範囲が確定して ready になったら有効化される
  rangeBar = createRangeBar({
    onScrub,
    onCommit: onRangeCommitted,
    onSeekPlay: (sec) => void onSeekPlay(sec),
    maxClipSec: () => maxClipSec,
  });
  rangeBar.element.id = RANGE_ID;

  // 拡大バーの下のテロップの帯。拡大バーと同じ時間の軸で描くので、拡大バーと一緒に作り直す。
  // ドラッグ中のシークは拡大バーと同じ onScrub、押して離したときは一覧の ▶ と同じ再生
  telopTrack = createTelopTrack({
    onScrub,
    onCommit: onTelopDragged,
    onPlay: (index) => void playTelop(index),
  });

  segmentList = createSegmentList({
    onSelect: (index) => {
      selectedIndex = index;
      applyStateToSelection();
    },
    onPlay: (index) => {
      selectedIndex = index;
      applyStateToSelection();
      void playRange();
    },
    onRemove: (index) => {
      // **テロップが残っている間は最後の 1 区間を消させない。** 区間が 0 個に
      // なると状態機械は idle に戻り、手入力の文言もまとめて消える
      if (currentSegments.length === 1 && currentTelops.length > 0) {
        setStatus(
          `テロップが ${currentTelops.length} 件残っています。先にテロップを消してください`,
        );
        return;
      }
      removedIndexOnNextState = index;
      send({ type: "REMOVE_SEGMENT", index });
    },
  });

  telopList = createTelopList({
    onAdd: onAddTelop,
    onSetStart: (index) => onMoveTelopEdge(index, "start"),
    onSetEnd: (index) => onMoveTelopEdge(index, "end"),
    onPlay: (index) => void playTelop(index),
    onRemove: (index) => {
      if (!canEditTelops()) return;
      send({ type: "REMOVE_TELOP", index });
    },
    onText: onTelopText,
  });

  // バーは拡大バー → テロップの帯の段 → 操作の行だけ。拡大バーは幅がそのまま精度になるので、
  // 一覧の窓の幅には縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の
  // spec A.1)。帯の段は拡大バーのトラックの**下**に置く: トラックの中に重ねると、区間のハンドルと
  // 帯の当たり判定が重なる (spec B.1)
  bar.append(rangeBar.element, telopTrack.element, row);
  // 一覧は区間・テロップの窓へ、設定は設定の窓へ (窓の分割の spec C1.4)。**中身ごと入れ替える。**
  // 足すだけにすると、バーを作り直すたびに古い一覧や設定が残って 2 重になる
  listWindow.body.replaceChildren(segmentList.element, telopList.element);
  settingsWindow.body.replaceChildren(settings.element);
  return bar;
}

/**
 * 再生位置を拡大バーへ流し続ける。
 *
 * 動画要素は SPA 遷移で差し替わるため、掴んだ参照を持ち回らず毎回取り直す。
 * 取れないときは目印を消すだけにして、次のフレームで見直す
 */
function watchPlayhead(): void {
  const step = (): void => {
    try {
      rangeBar?.setPlayhead(getVideo().currentTime);
    } catch {
      // 動画要素がまだ無いか差し替えの最中。位置を示しようがないので消す。
      // ここで投げると監視が止まり、以降ずっと更新されなくなる
      rangeBar?.setPlayhead(null);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * 動かしていない窓を最初の位置に置き直す。**`window` の resize とプレイヤーの大きさの変化で
 * だけ呼ぶ** (spec A.2)。ページのスクロールでは呼ばない: 窓は画面に浮いたまま、コメント欄を
 * 読む間も同じ位置で操作できるようにする
 */
function placeUnmovedWindows(): void {
  // 枠が使えるかも見直す (1 列表示との切り替えは resize で起きる。C2.1)。変わったら窓を出し直す (退避 / 枠へ戻す)
  if (dockManager.attach(dockAnchors())) refreshWindows();
  for (const id of WINDOW_IDS) placeInitial(id);
}

/** 大きさを見ているプレイヤー。**SPA 遷移や再描画で要素が替わる**ので、mount のたびに確かめる */
let observedPlayer: Element | null = null;
/** プレイヤーの大きさの変化 (シアターモードの切り替えなど) を拾う */
const playerObserver = new ResizeObserver(() => placeUnmovedWindows());

function watchPlayerSize(): void {
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === observedPlayer) return;
  playerObserver.disconnect();
  observedPlayer = player;
  if (player !== null) playerObserver.observe(player);
}

function mount(): void {
  // ドック枠を差す先に付け直す (C2.7)。YouTube が子を作り直すと枠ごと外れる。使えるかが変わったら
  // (1 列表示になった・戻った・差す先が消えた) 窓を出し直す (退避 / 枠へ戻す)。**バーの有無より先に見る**
  if (dockManager.attach(dockAnchors())) refreshWindows();
  // 浮いた窓は body の直下に置く (#below の中だと YouTube の再描画で外れる)。**バーの有無より先に見る。**
  // body の子を差し替えられると窓だけが外れる。**使える枠に入っている窓は枠の中のまま** (枠ごと差し直すのは attach)
  for (const id of WINDOW_IDS) {
    const slot = dockManager.slotOf(id);
    if (slot !== null && dockManager.isUsable(slot)) continue;
    const frame = windowOf(id).element;
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
  // **バーの有無より先に見る。** バーを作り直さなくても、プレイヤーの要素だけが替わることがある
  watchPlayerSize();
  if (document.getElementById(BAR_ID) !== null) return;

  // #below にはもう何も置かないが、「動画ページのページができたか」の目印として見続ける
  // (spec A.3)。まだ無い間にバーを作ると、タイトルもプレイヤーも読めないまま IN を押せる
  const anchor = document.querySelector(YT_SELECTORS.mountAnchor);
  if (anchor === null) {
    // applyMode が中身の根 (BAR_ID) を外した直後にここで抜けると、バーの窓が中身の無いまま
    // 出続ける。refreshWindows は中身の根が無ければバーの窓を隠すので、ここで一度呼んでおく
    refreshWindows();
    return; // 動画ページ未生成。次の observe で再試行する
  }

  // 前のバーが外されていることがある (モードの切り替え)。参照だけ差し替えると
  // rAF とリスナを抱えた古いインスタンスが解放されないまま残る
  const previousBar = rangeBar;
  const previousTrack = telopTrack;
  // buildBar が rangeBar と telopTrack を新しいインスタンスに差し替える
  const bar = buildBar();
  previousBar?.destroy();
  // 帯の段も rAF (シークの間引き) とドラッグのリスナを抱えうる。拡大バーと同じく捨てる
  previousTrack?.destroy();

  // 窓の中身だけを入れ替える。窓は作り直さないので、位置も大きさも変わらない (spec A.3)
  barWindow.body.replaceChildren(bar);

  // 監視は 1 度だけ張る。mount は DOM 変化のたびに呼ばれるので、
  // ここで毎回張ると同じ更新が何本も走る
  if (!playheadWatched) {
    playheadWatched = true;
    watchPlayhead();
  }

  // 作り直したバーは空で無効の状態。確定済みの範囲があれば載せ直す
  rangeBar?.setEnabled(canAdjustRange());
  const restored = selectedSegment();
  if (restored !== null) {
    try {
      paintRangeBar(restored, getVideo().duration);
      setStatus(rangeLabel(restored));
    } catch (error) {
      // 表示を戻せないだけで、範囲そのものは service worker が持っている
      console.warn(`拡大バーを復元できませんでした: ${String(error)}`);
    }
  }
  refreshOverlay();
  refreshTelopPreview();
  // 作り直した一覧は空で隠れている。次の状態通知を待たずに手元の写しで描き直し、
  // 窓の表示も決め直す
  refreshLists();
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
    const first = state.segments[0];
    if (first === undefined) {
      send({ type: "FAIL", reason: "internal-error" });
      return;
    }
    void prepareRecording(first.startSec, state.meta.videoId);
    return;
  }
  if (state.kind === "recording") {
    void runRecording(state.segments);
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
      const current = selectedSegment();
      if (current !== null) {
        setStatus(rangeLabel(current));
      }
    })
    .catch((error: unknown) => {
      // 拡張の再読み込み直後などは受け手が居ない。状態を取り戻せないだけで、
      // 次の state/changed で追いつくため、ここで操作を止める必要はない
      console.warn(`状態を取得できませんでした: ${String(error)}`);
    });
}

/** 設定のうちテロップの見た目を取り込む。起動時と、別のタブで変わったときに呼ぶ */
function applyTelopSettings(settings: Settings): void {
  telopStyle = telopStyleOf(settings);
  refreshTelopPreview();
}

/**
 * 起動時に設定を読む。
 *
 * 読めなくても操作は続けさせる。既定値のまま動く方が、バーごと出ないより
 * ましで、上限の食い違いも起きない (全員が既定値を見る)
 */
function loadInitialSettings(): void {
  void loadSettings()
    .then((settings) => {
      maxClipSec = settings.maxClipSec;
      applyTelopSettings(settings);
      applyMode(settings.mode);
    })
    .catch((error: unknown) => {
      console.warn(`設定を読めませんでした: ${String(error)}`);
    });
}

/**
 * 起動時に覚えた窓の位置を読む。**済むまで窓を出さない** (refreshWindows が layoutReady を見る)。
 *
 * 覚えた位置も画面に収まるよう詰めてから使う (place が詰める。大きい画面で覚えた位置を
 * 小さい画面で開いたとき)。読めなくても最初の位置で出す (loadWindowLayout は失敗を warn して
 * 空を返す。spec A.2)
 */
function loadInitialLayout(): void {
  void loadWindowLayout()
    .then((layout) => {
      for (const id of ["bar", "list", "settings"] as const) {
        const rect = layout.float[id];
        if (rect === undefined) continue;
        // 写しを書き換える 3 箇所の 1 つ (floatLayout の doc)
        floatLayout[id] = rect;
        windowOf(id).place(rect);
      }
    })
    .catch((error: unknown) => {
      // 窓を置けないのは想定外。それでも出さないままにはしない (spec A.2)
      console.warn(`覚えた窓の位置を使えませんでした: ${String(error)}`);
    })
    .finally(() => {
      layoutReady = true;
      refreshWindows();
    });
}

// 設定は**別のタブで変えられる**。保存ボタンに繋ぐだけでは、開いたままの
// タブが古い上限のまま残り、そのタブでだけ録画の長さが違うことになる。
//
// **通知が新しい値を持っているので読み直さない。** ここで loadSettings すると、
// 設定を 1 回保存するたびに、開いている YouTube タブの数だけ storage を
// 往復することになる (書いた当のタブでも発火する)
chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = areaName === "sync" ? changes[SETTINGS_KEY] : undefined;
  if (change === undefined) return;
  const settings = mergeSettings(change.newValue);
  maxClipSec = settings.maxClipSec;
  applyTelopSettings(settings);
  applyMode(settings.mode);
});

/** 直前に見ていた URL。SPA 遷移の検出に使う */
let lastHref = location.href;

// テーマの切り替えに追従する。YouTube は <html dark> を付け外しするだけで
// 画面を作り直さないため、DOM 変化の監視では拾えない
const themeObserver = new MutationObserver(() => {
  const dark = isDarkTheme();
  const bar = document.getElementById(BAR_ID);
  if (bar !== null) applyPalette(bar, dark);
  // 3 つの窓は body の直下にある。ページの配色は継がれない
  applyPalette(barWindow.element, dark);
  applyPalette(listWindow.element, dark);
  applyPalette(settingsWindow.element, dark);
  // ドック枠 (タブの列と目印) も自前の配色
  for (const slot of Object.values(dockManager.elements)) applyPalette(slot, dark);
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["dark"],
});

// 全画面の間は 3 つの窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
document.addEventListener("fullscreenchange", refreshWindows);

// ブラウザの大きさが変わったら、動かしていない窓の最初の位置を取り直す (spec A.2)。
// 動かした窓は置いた場所のまま (画面の外へ出る分は窓の枠が自分で詰める)
window.addEventListener("resize", placeUnmovedWindows);

// YouTube は SPA 遷移するため DOM 変化を監視して再マウントする
const observer = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    // 別の動画へ移ったら、範囲も帯もこの画面のものではなくなる。帯を残すと
    // 旧動画の位置に青い帯が出たままになり、ハンドルを動かせてしまうと
    // 見えていない動画の範囲を書き換えることになる
    rangeBar?.setEnabled(canAdjustRange());
    refreshOverlay();
    refreshTelopPreview();
    // 一覧も同じ規則で描き直す。区間・テロップの窓に A の区間が B の画面で出続けないように。
    // 動画ページ以外へ移ったら、3 つの窓ごと隠れる (refreshWindows)
    refreshLists();
  }
  mount();
});
observer.observe(document.body, { childList: true, subtree: true });
mount();
loadInitialSettings();
loadInitialLayout();
recoverFromState();
