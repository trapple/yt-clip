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
import { BAR_STYLE, applyPalette, isDarkTheme } from "@/content/styles";
import { fixVideoDisplayMatrix } from "@/content/display-matrix";
import { TRIM_MARGIN_SEC, makeDefaultRange, nudgeRange, type HandleKind } from "@/content/range-math";
import { createTrimPanel, type TrimPanel } from "@/content/trim-panel";
import { snapPointsIn, wordsInWindow } from "@/content/trim-words";
import {
  DrmProtectedError,
  assertRecordable,
  startRecording,
  type RecorderHandle,
} from "@/content/recorder";
import { createDockManager, type DockManager } from "@/content/dock";
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
  type PanelWindow,
} from "@/content/panel-window";
import { createTelopList, type TelopList } from "@/content/telop-list";
import { createTelopPreview, type TelopPreview } from "@/content/telop-preview";
import { createTelopTrack, type TelopTrack } from "@/content/telop-track";
import { YT_SELECTORS } from "@/content/selectors";
import { createSwitchDriver } from "@/content/switch-driver";
import {
  TRANSCRIPT_SOURCE_LABEL,
  createDefaultTranscriptLoader,
  transcriptLogLine,
  type TranscriptLoader,
  type TranscriptStatus,
} from "@/content/transcript-loader";
import { placeTranscriptItems } from "@/content/transcript-items";
import { createTranscriptPanel, type TranscriptPanel, type TranscriptView } from "@/content/transcript-panel";
import {
  isLineInSegments,
  lineIdsBetween,
  setLinesSelected,
  toggleTelopHidden,
  type Clip,
} from "@/content/transcript-selection";
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
  currentViewport,
  initialBarRect,
  initialDocks,
  loadWindowLayout,
  saveWindowLayout,
  type DockSlotId,
  type WindowId,
  type WindowLayout,
} from "@/content/window-layout";
import { encodeBase64 } from "@/shared/base64";
import type { ChannelResponse, Message, MessageResponse } from "@/shared/messages";
import {
  loadSettings,
  mergeSettings,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  type Channel,
  type Settings,
} from "@/shared/settings";
import { MAX_TELOP_TEXT_LENGTH, hasRenderableTelops } from "@/shared/telop";
import type { TranscriptLine } from "@/shared/transcript";
import { telopStyleOf, type TelopStyle } from "@/shared/telop-style";
import { DEFAULT_MAX_CLIP_SEC, formatTime, validateRange } from "@/shared/time";
import { isOverLimit, totalSec } from "@/shared/timeline";
// BUSY_KINDS は状態の性質なので types.ts で共有している
import {
  acceptsSetClip,
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
 * 区間・テロップの窓の枠 (窓の分割の spec C1.1)。中身の箱は `${id}-body`
 * (panel-window.ts)。E2E と screenshots.mjs もこの id で探す
 */
const LIST_WINDOW_ID = "yt-clip-list";
/**
 * 窓の見出しの文言 = ドック枠のタブの文言 (窓の分割の spec C1.1)。バーは見出しの行を作らないので、タブだけの文言
 */
const WINDOW_TITLES: Record<WindowId, string> = {
  bar: "バー",
  list: "区間・テロップ",
};

/**
 * 録画品質は再生解像度が上限になるため、低いときは事前に知らせる。
 * `captureStream()` が返すのはデコード済みのフレームなので、解像度は
 * 再生中の画質そのものになる。360p で再生していれば 360p で録れる。
 */
const MIN_RECOMMENDED_HEIGHT = 720;

/**
 * いま画面に出ている区間列。**状態機械が正で、これはその写し。**
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
 * 録画するテロップと見た目。**録画開始時に固定する。** 録画中に popup で見た目を
 * 変えても、途中で見た目が変わるクリップを作らない。null なら今の経路で録る
 */
let recordingTelops: { telops: Telop[]; style: TelopStyle } | null = null;
/**
 * 拡大バーがいま編集している区間の位置。区間が無ければ -1。
 *
 * **ここが選択の唯一の持ち主。** 一覧にも持たせると同期が要る。
 * 状態機械は区間を時間順に並べるので、足した・動かした直後は範囲で引き直す (selectRangeOnNextState)。それ以外は数が変わったときだけ詰める
 */
let selectedIndex = -1;
let telopList: TelopList | null = null;
/**
 * プレイヤーの上のテロップ。バーを作り直しても使い回す (video に付いているため)。
 * **オンの間だけある** (マスタースイッチの spec §2.1): start() が作り、stop() が destroy する (canvas・video の seeked・
 * rVFC・ResizeObserver を外す)。`!` の意味は下の listWindow と同じ
 */
let telopPreview!: TelopPreview;
/**
 * 覚えた位置 (chrome.storage.local) の読み込みが済んだか。**済むまで窓を出さない**
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
 * **オンの間は 1 つを使い回す。** 窓の位置を持つので、バーを作り直すたびに作り直さない。中身の入れ替えは
 * `buildBar`、body への付け直しは `mount`、出すかの判定は `refreshWindows` が行う。
 *
 * **オンの間だけある** (マスタースイッチの spec §2.1)。start() の createWindows が作り、stop() が destroy する。
 * `!` は「start() が必ず先に作る」の意味: 触る経路 (mount・refreshWindows・listener) はすべて start() の中か、start() が
 * 張った listener から呼ばれる。stop() の後に古い参照へ触る非同期の続きは isCurrentRun で断つ (判断メモ 6・7)
 */
let listWindow!: PanelWindow;
/**
 * バーの窓。拡大バーと操作の行 (中身の根 #yt-clip-bar) を入れる。
 *
 * **オンの間は 1 つを使い回す** (spec A.3)。YouTube の再描画でバーを作り直しても窓は作り直さないので、
 * 位置と大きさは変わらない。見出しの行は作らず、操作の行の左端のつまみ (⠿) で動かす
 * (見出しの行ぶん高くなると、1440x795 でプレイヤーの下端を覆うため。spec A.1)。オンの間だけあるのも同じ
 */
let barWindow!: FloatingWindow;
/**
 * ページの中のドック枠 2 か所 (プレイヤーの下・おすすめ動画の上) とタブ (窓の分割の spec C2)。
 * **枠の中だけを持つ**: 窓を出す条件は refreshWindows、浮いた窓の位置は placeInitial / placeUnderPointer が決める。
 * オンの間だけあるのも同じ (枠は #below / #secondary-inner に差さるので、オフのページには残さない)
 */
let dockManager!: DockManager;

/**
 * 2 つの窓とドック枠を作る (start() の最初)。**import 時には作らない**: createFloatingWindow は window の resize を張り、
 * ドック枠は mount で YouTube の要素に差さる。オフで読み込まれたページにはどれも残さない (マスタースイッチの spec §1)
 */
function createWindows(): void {
  listWindow = createPanelWindow({
    id: LIST_WINDOW_ID,
    title: WINDOW_TITLES.list,
    onUserMove: (rect) => rememberWindowRect("list", rect),
    onResetRequest: () => resetWindow("list"),
    // 見出しのドラッグの落とし先の当たり判定 (C2.3)。枠に引き取られたら onUserMove は来ない。
    // オフの後 (ドラッグ中に片付けて lostpointercapture が届いた) に破棄済みの枠を当てない判断は
    // dockManager.drag 自身が持つ (dock.ts の destroy。どの窓も同じ)
    onDragPoint: (phase, point) => dockManager.drag("list", phase, point) !== null,
  });
  // 窓は body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
  applyPalette(listWindow.element, isDarkTheme());
  barWindow = createFloatingWindow({
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
  dockManager = createDockManager({
    windows: { bar: barWindow, list: listWindow.frame },
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
}
/**
 * 状態機械から最後に届いた種類。
 *
 * いま状態機械がどの状態か (IN が作り直すか頭を合わせるかの判定と、録画の監視に使う)。`busy` だけでは、
 * 録画済みクリップを抱えた `preview` / `posted` / `degraded` を見分けられない
 */
let lastKind: ClipState["kind"] = "idle";
/**
 * 次に状態が届いたとき、この範囲の区間を選ぶ。区間を足した・動かした直後は**その区間**を選ぶ。
 * 前の区間が選ばれたままだと、続けて OUT を押したときに前の区間の終端が動いて事故になる。
 * **位置ではなく範囲で覚える**: 状態機械は区間を時間順に並べるので、足した区間・動かした区間の位置は変わりうる
 */
let selectRangeOnNextState: ClipRange | null = null;
/** 次に状態が届いたとき、選んだ区間の行を区間・テロップの窓の見える範囲に入れる (区間を足した直後) */
let revealSegmentOnNextState = false;
/**
 * 次に状態が届いたとき、テロップの一覧の末尾の行を区間・テロップの窓の見える範囲に入れる。
 *
 * `revealSegmentOnNextState` と同じ形。**クリックの時点では行がまだ無い** (状態機械の
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
/** 詰める欄 (ADR 0001)。拡大バーとテロップの帯を中に抱える。バーと一緒に作り直す */
let trimPanel: TrimPanel | null = null;
/** 再生位置の監視を張ったか。mount は DOM 変化のたびに呼ばれる */
let playheadWatched = false;
/** 再生位置のループの rAF の handle。止めるのは stop() (オフの間に rAF を残さない。spec §1) */
let playheadFrame = 0;
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

/** start() から stop() までの間か (マスタースイッチの spec §2.1)。二度の start()・走っていない stop() を見分ける */
let running = false;
/**
 * start() と stop() のたびに進める回の番号。**非同期の続き (storage の読み・service worker の応答・seek の完了) は、
 * 始めたときの番号と今の番号が同じときだけ画面と動画に触る** (isCurrentRun)。オフにした後や、オフ → オンで作り直した後に
 * 古い続きが届いて、片付けた窓を描き直す・帯を差す・再生を始める・監視を張る、をしない (オフの間は 0。spec §1。判断メモ 7)
 */
let runId = 0;

/** 続きを始めたときの番号 id が、今走っている回のものか */
function isCurrentRun(id: number): boolean {
  return running && id === runId;
}

/**
 * このタブで録画の準備・録画・書き出しが走っているか (マスタースイッチの spec §4.1)。**立っている間はオフでも stop を
 * 待つ** (driver の canStop)。
 *
 * **状態機械の busy ではない**: busy は応答で受け取った写しで、録画していない別の YouTube タブでも真になる。そのタブには
 * state/changed が届かない (router は録画対象のタブにしか同報しない) ので、busy でオフを待たせると永久に片付かない。
 *
 * 立てる / 下ろすのは state/changed を受けたとき (届いた = このタブが録画対象。busy の間は立つ)。ほかに下ろすのは、
 * オフの中止 (cancelForSwitch) の応答が busy でないときと、録画の結末 (notifyOutcome) を送り終えたとき。応答
 * (send・content/loaded) では変えない (録画していないタブにも返る)。handle だけでは prepareRecording の seek 中を拾えない
 */
let capturing = false;
/**
 * `capturing` が偽 → 真に立った回数 (= このタブで始まった録画の数)。オフのための中止の応答が、送った後に始まった
 * **別の録画** より古いかを見分ける (cancelForSwitch。判断メモ 33)。受けた state/changed の数では数えない: 同じ録画の中の
 * seeking → recording の進みでも応答を捨ててしまい、ready の同報が届かなければ永久に待つ
 */
let captureRun = 0;

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
  /** 届かなかった・応答が無かったときに呼ぶ */
  undelivered?: () => void,
): void {
  // 応答が届くまでにオフにした・作り直したら、画面に触らない (isCurrentRun の doc)
  const id = runId;
  void chrome.runtime
    .sendMessage({ type: "clip/event", event } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (!isCurrentRun(id)) return;
      if (response === undefined) {
        setStatus("拡張から応答がありませんでした");
        undelivered?.();
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
      if (!isCurrentRun(id)) return;
      setStatus(`操作を送信できませんでした: ${String(error)}`);
      undelivered?.();
    });
}

/**
 * service worker へ録画の進行を伝える。
 *
 * 録画結果は base64 で数十 MB になりうる。メッセージ長の超過や拡張コンテキストの
 * 無効化で送れなかったとき、黙って捨てると service worker は `encoding` のまま、
 * popup は `actions: []` で操作不能になる。ユーザーに見せたうえで、小さい
 * `FAIL` を送って状態を抜けさせる。
 *
 * **送り終えたら resolve する** (届いても、届かずに FAIL を送り出した後でも。reject しない)。録画の結末を送り終えた
 * 時点を notifyOutcome が知るため
 */
function notify(message: Message): Promise<void> {
  return chrome.runtime.sendMessage(message).then(
    () => undefined,
    (error: unknown) => {
      setStatus(`拡張への送信に失敗しました: ${String(error)}`);
      // 成果物を渡せていない以上、録画が中断されたのと結果は同じ
      send({ type: "FAIL", reason: "recording-aborted" });
    },
  );
}

/**
 * 録画の結末 (recorder/done・recorder/failed) を送る。**送り終えたら、このタブの録画は終わり** (spec §4.1)。オフを
 * 待っていたなら、ここで片付けてよい。state/changed (preview / failed) は待たない: service worker が応答を返さないときに
 * 永久に待たないため。届かなかったときは notify が FAIL を送り出した後に片付ける (FAIL の応答は待たない。判断メモ 4)
 */
function notifyOutcome(message: Message): void {
  void notify(message).then(endCapture);
}

/** このタブの録画が終わった。オフを待っていたなら、ここで stop() が走る */
function endCapture(): void {
  capturing = false;
  driver.reconcile();
}

/**
 * バーの中身 (中身の根とその中の部品) を id で引く。**バーの窓の中を探し、文書につながっているかは見ない** (spa-inject ③)。
 * 動画ページ以外では窓をページから外し、差す先 (#below) が一時的に外れるとバーは外れた枠の中に残る。document から
 * 引くとその間は「バーが無い」ことになり、出す判断 (refreshWindows) と作り直しの判断 (mount) が食い違い、届いた状態も
 * 描かれない。窓はオンの間 1 つを使い回すので、窓の中を見れば足りる
 */
function barPart(id: string): HTMLElement | null {
  return barWindow.body.querySelector<HTMLElement>(`#${id}`);
}

function setStatus(text: string): void {
  const status = barPart(`${BAR_ID}-status`);
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

/** 状態の欄の最初の案内。区間が無いときに出す */
const INITIAL_STATUS = "IN を押して開始位置を指定";

/** 同じ範囲を指しているか。別のオブジェクトでも値が同じなら同じ範囲 */
function sameRange(a: ClipRange, b: ClipRange): boolean {
  return a.startSec === b.startSec && a.endSec === b.endSec;
}

/**
 * 状態機械の区間に、送った範囲の区間があるか。区間を変える送信が受け付けられたかの判定に使う
 * (拒まれたら send が画面を状態機械に戻し、「受け付けられませんでした」を出す)。**位置では見ない**: 状態機械は
 * 区間を時間順に並べるので、動かした区間の位置は変わりうる
 */
function hasSegment(state: ClipState, range: ClipRange): boolean {
  return state.kind === "ready" && state.segments.some((segment) => sameRange(segment, range));
}

/** 拡大バーが編集している区間。無ければ null */
function selectedSegment(): ClipRange | null {
  return currentSegments[selectedIndex] ?? null;
}

/**
 * いま開いている動画の videoId。動画ページでなければ null。
 * 再生画面から離れること自体は異常ではないので、例外にはしない。
 */
function currentVideoId(): string | null {
  return videoIdOf(location.href);
}

/** URL の動画 ID。動画ページでなければ null */
function videoIdOf(href: string): string | null {
  try {
    return parseVideoId(href);
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

/**
 * IN で作り直す前の確かめを出した後か。もう一度 IN を押したら作り直す。状態が届いたら下ろす
 * (別の操作を挟んだら、確かめはやり直す)
 */
let startOverArmed = false;

/**
 * IN ボタン (ADR 0001: モードを無くし、区間が 1 つならシンプルと同じにする)。
 *
 * - **区間が 1 つでテロップが無い**: いつも今の位置から範囲を作り直す (`MARK_IN`)。これまでのシンプルと同じ
 *   (区間の前でも後ろでも、録画した後でも)
 * - **区間が 2 つ以上かテロップがある**: ready / posted なら選んでいる区間の頭だけを今の位置に動かす。録画した後
 *   (preview / degraded) は、消える区間とテロップの数を出し、もう一度押したら作り直す (手で作った区間とテロップを
 *   確かめずに捨てない)
 * - **この動画の区間が画面に無い** (区間が無い・失敗・別の動画の区間しか無い): 作り直す
 *
 * **IN を「区間を追加」に置き換えない。** OUT があるのに IN が無い状態になり、一度作った区間の頭を詰められなくなる
 */
function onMarkIn(): void {
  // 録画中に打ち直されると状態機械だけが範囲を作り直し、録画は走り続けて取り残される。状態機械と router にも
  // 同じガードがあるが、ここで止めればユーザーに理由をすぐ返せる
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }
  const shown = currentSegments.length > 0 && rangeVideoId === currentVideoId();
  const simple = currentSegments.length === 1 && currentTelops.length === 0;
  if (shown && !simple) {
    if (lastKind === "ready" || lastKind === "posted") {
      onMarkSegmentStart();
      return;
    }
    if (!startOverArmed) {
      startOverArmed = true;
      setStatus(
        `作り直すと区間 ${currentSegments.length} 個とテロップ ${currentTelops.length} 件が消えます。作り直すならもう一度 IN を押してください`,
      );
      return;
    }
  }
  startOverArmed = false;
  startOver();
}

/**
 * 今の位置から範囲を作り直す (`MARK_IN`)。区間とテロップは置き換わる。
 *
 * **録画した後 (preview) からでも受け付ける。** 状態機械の「MARK_IN はどの状態からでも ready へ」を content 側で
 * 狭めると、録り終えた後に次の切り抜きを始められなくなる。代償として、録画済みクリップへの参照 (clipId) は状態から
 * 外れる (IndexedDB には残るが popup から辿れなくなる)。この非対称は意図したもの
 */
function startOver(): void {
  const video = getVideo();
  const meta = getVideoMeta();
  // 既定の長さの範囲をここで作る。状態機械は長さの決め方を知らない
  const range = makeDefaultRange(video.currentTime, video.duration, maxClipSec);
  // 範囲が変われば、前の範囲を見ている再生の監視は用済み (消した楽観描画が外していた)
  cancelPreviewWatch();
  // 楽観的に描かない。状態機械の答えを待ってから描く (区間 1 つの ready になり、それが選ばれる)。
  // rangeVideoId も答えの meta から取る (先に書くと、答えが来なかったとき前の動画の区間に今の動画の秒を書きうる)
  send(
    { type: "MARK_IN", range, meta },
    (state) => state.kind === "ready" && state.segments.length === 1 && hasSegment(state, range),
  );
}

/**
 * 選択だけを画面に反映する。状態機械には何も送らない。
 *
 * 選び直しは状態の変化ではないので、`send` を通すと往復のぶん反応が遅れる
 */
function applyStateToSelection(): void {
  // 一覧に何を出すかの規則は `listedItems` の 1 箇所にまとめる (別の動画では空、など)
  // 欄の見出しの「· 詰めている」を選び直した区間に合わせる (refreshTranscript は最後に詰める欄も描く)
  refreshTranscript();

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
 * 「＋ 区間を追加」。今の再生位置から新しい区間を作る。
 *
 * **楽観的に描かない。** 状態機械の答えを待ってから描く (`applyStateToDisplay` が反映する)
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
  selectRangeOnNextState = range;
  revealSegmentOnNextState = true;
  // 選ぶ区間が変わるので、前の区間を見ている再生の監視は用済み
  cancelPreviewWatch();
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

/**
 * 文言の確定。改行はそのまま持つ。**送らなかったら false** (一覧はその入力欄を下書きとして
 * 残し、次の描き直しで前の文言に戻さない)
 */
function onTelopText(index: number, text: string): boolean {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return false;
  if (telop.text === text) return true;
  // 状態機械は上限を超えた文言を UI のバグとして拒む。送る前に止めて理由を出す。
  // 入力欄は消さない (削って直してもらう)
  if (rejectLongTelopText(text)) return false;
  send({ type: "UPDATE_TELOP", index, telop: { ...telop, text } });
  return true;
}

/** そのテロップの頭から再生する。範囲再生の監視は解く (押した場所からの再生が止まる) */
/**
 * テロップの文言が上限を超えていたら理由を出して true。状態機械は上限を超えた文言を UI のバグとして拒むので、
 * 送る前に止める (入力欄は消さない。削って直してもらう)
 */
function rejectLongTelopText(text: string): boolean {
  if (text.length <= MAX_TELOP_TEXT_LENGTH) return false;
  setStatus(`テロップは ${MAX_TELOP_TEXT_LENGTH} 文字までです (いま ${text.length} 文字)`);
  return true;
}

/** 最後の区間を消すとテロップも消えるので止める、の理由 (区間の一覧の ✕ と欄で同じ文言) */
function telopsRemainMessage(count: number): string {
  return `テロップが ${count} 件残っています。先にテロップを消してください`;
}

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
 * IN (区間を組み立てている途中)。選択中の区間の**頭だけ**を今の位置に動かす。
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
  // 尻より後ろで押した = 新しい場面を始めたいことが多い。区間を組み立てている途中なので作り直さず、道を示す
  if (next.startSec >= editing.endSec) {
    setStatus(`IN が区間の尻 (${formatTime(editing.endSec)}) より後ろです。新しい区間は ＋ 区間を追加 で作れます`);
    return;
  }
  const validation = validateRange(next.startSec, next.endSec, maxClipSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }

  // 頭を動かすと時間順の位置が変わりうる。選択は範囲で追う (selectRangeOnNextState)
  cancelPreviewWatch();
  selectRangeOnNextState = next;
  send({ type: "ADJUST_SEGMENT", index: selectedIndex, range: next }, (state) => hasSegment(state, next));
}

function onMarkOut(): void {
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }
  const editing = selectedSegment();
  if (editing === null) {
    setStatus("先に区間を追加してください");
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

  // 範囲が変われば、前の範囲を見ている再生の監視は用済み (消した楽観描画が外していた。外さないと、
  // 「▶ 区間を見る」の最中に尻を伸ばしても古い OUT で止まる)
  cancelPreviewWatch();
  // 楽観的に描かない。状態機械の答えを待ってから描く (`onAddSegment` と同じ)
  selectRangeOnNextState = next;
  send({ type: "MARK_OUT", index: selectedIndex, sec: next.endSec }, (state) => hasSegment(state, next));
}

/**
 * 拡大バーでのドラッグが確定したとき。
 *
 * **確定したら窓を前後 2 秒で映し直す** (詰める欄。もっと伸ばしたいときはもう一度端まで引く)
 *
 * 拡大バーから直接呼ばれるので click 用の guard を通らない。ここで落とすと
 * 範囲が service worker へ送られず、画面の見た目だけが新しい範囲になって
 * 実際の状態と食い違う
 *
 * **範囲が変わっていなければ送らない** (窓の映し直しだけする)。掴んで離しただけ (キーで動かす端を選ぶため) で
 * ADJUST_SEGMENT を送ると、投稿した後の状態が ready へ戻り、投稿したクリップの参照が理由なく外れる。
 * 欄の行を押した答え (`pendingClip`) を待つ間も送らない (状態機械の区間の並びがまだ手元と違い、位置 (index) で当てる
 * ADJUST_SEGMENT が別の区間に当たる)。拡大バーは今の区間で描き直す。
 *
 * 送ったら答えを待つ範囲 (`rangeAwaiting`) を覚えて true を返す
 */
function onRangeCommitted(range: ClipRange): boolean {
  // 状態機械が受け付けない範囲変更は、画面にも反映しない
  if (!canAdjustRange()) return false;

  cancelPreviewWatch();

  try {
    // 動画が取れるかを先に確かめる。範囲を覚えてから落ちると、送っていない
    // 範囲が content script 側にだけ残り、まさにこの関数が防ごうとしている
    // 「画面と状態の食い違い」が起きる
    const durationSec = getVideo().duration;

    const current = selectedSegment();
    if (current !== null && (sameRange(current, range) || pendingClip !== null)) {
      paintRangeBar(current, durationSec);
      return false;
    }

    currentSegments = currentSegments.map((segment, index) =>
      index === selectedIndex ? range : segment,
    );
    paintOverlay(currentSegments, durationSec);
    paintRangeBar(range, durationSec);
    setStatus(rangeLabel(range));
    selectRangeOnNextState = range;
    rangeAwaiting = range;
    const settle = (): void => {
      if (rangeAwaiting === range) rangeAwaiting = null;
    };
    send(
      { type: "ADJUST_SEGMENT", index: selectedIndex, range },
      (state) => {
        const ok = hasSegment(state, range);
        // 拒まれたら待つのをやめる (待ち続けると ±0.1 が二度と効かない)
        if (!ok) settle();
        return ok;
      },
      settle,
    );
    return true;
  } catch (error) {
    setStatus(`範囲を確定できませんでした: ${String(error)}`);
    return false;
  }
}

/**
 * 区間の範囲を送って (ドラッグの確定・±0.1)、その範囲を持つ状態の通知を待っている範囲。**待つ間は ±0.1 を受けない。**
 * 答えを待たずに積むと、先に送った分の答えが届いた時点で手元の区間が巻き戻る (押した分が消える)。頭が前の区間を
 * 越えて並べ替わった後に、古い位置 (index) のまま次を送ると、隣の区間を書き換える。
 * **待つ範囲そのものを覚える** (真偽値にすると、先に送った別の操作の通知で早く下りる)
 */
let rangeAwaiting: ClipRange | null = null;

/**
 * 詰める欄の −0.1 / ＋0.1 (と `,` `.`)。拡大バーのドラッグの確定と同じ経路 (`onRangeCommitted`) で送る。
 *
 * **前に送った範囲の答えが届くまで、次は受けない** (`rangeAwaiting` の doc)。欄の行を押した答え (`pendingClip`) を
 * 待つ間も受けない (`onRangeCommitted` の doc)。
 * 動かした端の映像を出す (止めて、その位置へ)
 */
function onNudge(kind: HandleKind, deltaSec: number): void {
  if (!canAdjustRange() || rangeAwaiting !== null || pendingClip !== null) return;
  const range = selectedSegment();
  if (range === null) return;
  try {
    const next = nudgeRange(kind, deltaSec, range, getVideo().duration, maxClipSec);
    if (sameRange(next, range)) return;
    onRangeCommitted(next);
    onScrub(kind === "in" ? next.startSec : next.endSec);
  } catch (error) {
    setStatus(`区間を詰められませんでした: ${String(error)}`);
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
  const id = runId;
  try {
    // getVideo() を try の外に置くと、同期的な throw が Promise の拒否になり、
    // 呼び出し元の `void ...` で握り潰されてボタンが無反応に見える
    const video = getVideo();
    await seekTo(video, sec);
    // seek を待つ間にオフにしたら、再生を始めない。null を返すので、呼び出し側 (playRange) も範囲の監視 (rVFC) を
    // 張らない (オフの間は video に触らない。spec §1)。始めてしまった seek は止められない
    if (!isCurrentRun(id)) return null;
    await startPlayback(video);
    if (!isCurrentRun(id)) return null;
    return video;
  } catch (error) {
    if (!isCurrentRun(id)) return null;
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
  // 動画ページ以外では差さない (範囲を作った動画が分からない写しでも。spa-inject)
  const videoId = currentVideoId();
  if (currentSegments.length === 0 || videoId === null || rangeVideoId !== videoId) {
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
 * 範囲を作った動画を見ているときだけ出す。別の動画の
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
  // 動画ページ以外では canvas を差さない (spa-inject)
  const videoId = currentVideoId();
  const visible = videoId !== null && rangeVideoId === videoId;
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
  const box = barPart(ACTIONS_ID);
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
 * 一覧に出す区間とテロップ。**範囲を作った動画を見ているときだけ。**
 *
 * 別の動画の区間は出さない
 * (帯・プレビューと同じ規則)。画面に浮いた窓に出すので、SPA で動画 B へ移ったのに
 * 動画 A の区間が出続けると目立つ (spec §4)
 */
function listedItems(): { segments: ClipRange[]; telops: Telop[] } {
  if (rangeVideoId !== currentVideoId()) {
    return { segments: [], telops: [] };
  }
  return { segments: currentSegments, telops: currentTelops };
}

/** 窓の枠。id で引く (覚えた配置の鍵と同じ名前) */
function windowOf(id: WindowId): FloatingWindow {
  return id === "bar" ? barWindow : listWindow.frame;
}

/**
 * 窓の最初の位置 (spec A.2 / C1.3)。バーはプレイヤーの直下、区間・テロップの窓は画面の右上。
 * プレイヤーがまだ無ければ null (出たときに取り直す)。
 *
 * **プレイヤーの画面上の位置をそのまま使う。** ページがスクロールされていても、今見えている
 * 位置の直下に置く (窓は画面に固定なので、ページの座標に直さない)。バーの高さは出ている窓で
 * 測る (隠れている窓は 0 になる。そのため出した直後に取り直す: refreshWindows)
 */
function initialWindowRect(id: WindowId): WindowRect | null {
  const viewport = currentViewport();
  if (id === "list") return initialListRect(viewport);
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === null) return null;
  const box = player.getBoundingClientRect();
  // **高さを測る前にプレイヤーの幅を当てる。** 覚えた位置が無い読み込みでは窓は最小の幅
  // (480px) のままで、操作の行は 2 段に折り返して背が高く測れる。その高さで
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
 * (バーはプレイヤーの幅、区間・テロップの窓は幅 400px・高さは中身)。
 *
 * - バー: ⠿ が指の下に残るよう、窓の左上 = 指 − ⠿ の窓の中の位置。`grab` (⠿ で引き出したとき、押した点の窓の中の
 *   位置) が無ければ (タブから引き出したとき) ⠿ の中心を測る
 * - 区間・テロップの窓: 掴んだタブの位置関係を保つ。窓の左端 = 指 − タブの中で掴んだ x (窓の幅に収める)、
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
  const viewport = currentViewport();
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
  const grip = barPart(BAR_ID)?.querySelector("[data-role='grip']");
  if (grip == null) return { x: 0, y: 0 };
  const frame = barWindow.element.getBoundingClientRect();
  const box = grip.getBoundingClientRect();
  return { x: box.left - frame.left + box.width / 2, y: box.top - frame.top + box.height / 2 };
}

/**
 * ドック枠を差す先 (C2.1)。右の枠は #secondary-inner、無ければ #secondary。
 * **動画ページ以外では差す先が無いものとして渡す** (dock.ts の attach が枠をページから外す)。YouTube は動画ページから
 * ホームへ移っても隠れた #below / #secondary-inner を残すので、要素の有無ではなく URL で決める (C2.7 の spa-inject の追記)
 */
function dockAnchors(): Record<DockSlotId, Element | null> {
  if (currentVideoId() === null) return { below: null, side: null };
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

/**
 * 覚える配置を組ごと保存する。**走っている間だけ効く** (保存の唯一の口)。ドラッグ中にオフにすると、外れた掴む場所へ
 * lostpointercapture が届いて onUserMove や dock の onChange がここへ来る。オフでは floatLayout を空にしてあるので、
 * 保存すると他の窓の覚えた位置を消す
 */
function persistWindowLayout(): void {
  if (!running) return;
  void saveWindowLayout(currentWindowLayout()).catch((error: unknown) => {
    // 覚えられないだけで、今の画面の窓は置いた場所にある。次に開くと前に覚えた配置で出る
    console.warn(`窓の位置を保存できませんでした: ${String(error)}`);
  });
}

/** ユーザーが窓を動かした・大きさを変えた (指を離した時点で 1 回)。次に開いたときも同じ位置に出す */
function rememberWindowRect(id: WindowId, rect: WindowRect): void {
  // **走っている間だけ効く。** ドラッグ中にオフにすると、外れた掴む場所へ lostpointercapture が届いて onUserMove が
  // ここへ来る。先へ進むと、退避中の窓は undock で body へ出し直され、片付けた窓がオフのページに戻る。
  // オフでは floatLayout も空にしてあるので書かない (persistWindowLayout の guard だけでは undock を止められない)
  if (!running) return;
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
 * 2 つの窓 (バーの窓・区間・テロップの窓) を出すか隠すかを決める。**`setVisible` を
 * 呼ぶのはここだけ** (右側パネルの spec §4 を窓ごとに広げた。窓の分割の spec C1.2。設定の窓は popup へ移した)。
 *
 * どれも隠すのは、覚えた位置を読み込む前 / 全画面 / 動画ページ以外 (動画ページ以外ではページからも外す。
 * leaveVideoPage)。そのうえで、バーは中身の根 (BAR_ID) がバーの窓の中にある間 (文書につながっているかは見ない。
 * barPart) だけ出す。区間・テロップの窓は、文字起こしの欄があるので動画ページではいつも出す
 */
function refreshWindows(): void {
  // 文字起こしの欄があるので、区間・テロップの窓は動画ページではいつも出す (区間が無くても行を選べる)
  const listShown = transcriptPanel !== null;
  // **`!= null` にする。** jsdom は fullscreenElement を持たず undefined を返すので、
  // `!== null` だとテストで常に全画面扱いになる。body 直下の fixed 要素は全画面の
  // 動画の上に残りうるので、全画面では出さない
  const fullscreen = document.fullscreenElement != null;
  const onVideoPage = currentVideoId() !== null;
  if (!onVideoPage) {
    leaveVideoPage();
    return;
  }
  // 覚えた位置を読む前に出すと、最初の位置に出てから覚えた位置へ跳ぶ絵になる (spec A.2)
  const canShow = layoutReady && !fullscreen;

  const barWasHidden = barWindow.element.hidden;
  const listWasHidden = listWindow.element.hidden;
  // 中身があるかで見る (文書につながっているかは見ない。barPart)
  barWindow.setVisible(canShow && barPart(BAR_ID) !== null);
  listWindow.setVisible(canShow && listShown);
  // 出す条件が変わったら、枠のタブ・枠の出し入れ・退避を合わせる (C2.2 / C2.7)。**出した直後の取り直しより先に:**
  // 使えない枠の窓は sync が body へ移して浮かせ (onEvacuate で最初の位置へ)、その後で下の取り直しが効く
  dockManager.sync();
  // 隠れていた窓は寸法が 0 で、最初の位置 (バーの高さで画面の下端に詰める) を測れていない。
  // **出した直後にだけ**取り直す。出ている間に状態が届くたびに取り直すと、ページを
  // スクロールした後に IN を押しただけで、バーがプレイヤーを追って跳ぶ (spec A.2)
  if (barWasHidden && !barWindow.element.hidden) placeInitial("bar");
  if (listWasHidden && !listWindow.element.hidden) placeInitial("list");
}

/**
 * 動画ページ以外へ移った (または動画ページ以外で読み込まれた)。**ページに何も差さない** (C2.7 の spa-inject の追記):
 * 窓を隠してページから外し、ドック枠も外す (dockAnchors が null を渡す)。窓・枠の中身・覚えた位置・記憶はメモリに
 * 残り、動画ページへ戻ると mount (と onPageMutated の付け直し) が差し直す。**sync は呼ばない**: 使えない枠の窓を
 * body へ退避させてしまう。再生位置のループも止める (ホームで毎フレーム回さない。戻れば mount が張り直す)。
 * シークバーの帯とプレビューの canvas は、それぞれの refresh が動画ページ以外では外す
 */
function leaveVideoPage(): void {
  barWindow.setVisible(false);
  listWindow.setVisible(false);
  dockManager.attach(dockAnchors());
  for (const id of WINDOW_IDS) windowOf(id).element.remove();
  stopPlayheadWatch();
}

/**
 * 浮いた窓を body の直下に付け直す。**使える枠に入っている窓は枠の中のまま** (枠ごと差し直すのは attach)。
 * #below の中だと YouTube の再描画で外れ、body の子を差し替えられると窓だけが外れる。動画ページ以外から戻ったとき
 * (leaveVideoPage が外した) もここで戻す
 */
function attachWindowsToBody(): void {
  for (const id of WINDOW_IDS) {
    const slot = dockManager.slotOf(id);
    if (slot !== null && dockManager.isUsable(slot)) continue;
    const frame = windowOf(id).element;
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
}

/**
 * 拡大バーを描き直し、同じ時間の軸で帯の段と詰める欄の単語も描き直す。**拡大バーの窓が変わる経路はここを通す**
 * (帯や単語だけが古い窓のまま残らないように)
 */
function paintRangeBar(range: ClipRange, videoDurationSec: number): void {
  rangeBar?.update(range, videoDurationSec);
  refreshTelopTrack();
  refreshTrimPanel();
}

/**
 * 詰める欄の見出し・単語・押せるかを手元の写しに合わせる。区間の数や選択が変わったとき (`refreshLists`) と、
 * 拡大バーの窓が変わったとき (`paintRangeBar`) に呼ぶ。同じ入力なら同じ絵になる (冪等)
 */
function refreshTrimPanel(): void {
  if (trimPanel === null) return;
  const { segments } = listedItems();
  const range = segments[selectedIndex] ?? null;
  const window = range === null ? null : (rangeBar?.window() ?? null);
  trimPanel.setEnabled(canAdjustRange());
  trimPanel.update({
    index: range === null ? -1 : selectedIndex,
    count: segments.length,
    range,
    totalSec: totalSec(segments),
    maxClipSec,
    window,
    words: window === null ? [] : wordsInWindow(transcriptLines(), window),
  });
}

/**
 * 拡大バーの下のテロップの帯を描き直す (フロートの窓の spec B)。拡大バーを描き直したとき
 * (`paintRangeBar`) と、テロップや出す条件が変わったとき (`refreshLists`) に呼ぶ。
 *
 * 出すテロップは一覧と同じ規則 (`listedItems`: 範囲を作った動画を見ている
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
  telopList?.setEnabled(canEditTelops());
  telopList?.update(telops, segments);
  refreshTranscript();
  refreshTelopTrack();
  refreshTrimPanel();
  refreshWindows();
}

/**
 * 使える枠に入っている (ページの中にある) か。退避中 (入っている枠が使えない間の浮いた窓) は false:
 * 見えている形 (浮いた窓) に合わせて、足した行の扱いを浮いた窓と同じにする
 */
function isDockedInPage(id: WindowId): boolean {
  const slot = dockManager.slotOf(id);
  return slot !== null && dockManager.isUsable(slot);
}

/**
 * 足した行を区間・テロップの窓の見える範囲に入れる。**応答を描いた後に呼ぶ** (クリックの時点では
 * 行がまだ無い)。押した結果が見えないと無反応に見える (右側パネルの spec §3)。
 *
 * **浮いた窓は前には出さない** (C1.2 は窓の中を送ることだけを求める)。前に出すと、もう一方の窓を
 * 見ながら区間を足したときにそちらが潜る。**ドック中ならタブを前に出すだけ** (C2.2): ページの中の窓は中身なりの
 * 高さで中でスクロールしないので送る先が無く、ページもスクロールしない (右側パネルの spec §3 と同じ理由)。
 * 窓が隠れている (全画面など) ときは何もしない。出す判断は `refreshWindows` のもの。
 * 欄の中のスクロールは `transcriptPanel.reveal` が済ませている (row はそれが返した要素)
 */
function revealInWindow(row: HTMLElement | null): void {
  if (row === null || listWindow.element.hidden) return;
  if (isDockedInPage("list")) {
    dockManager.activate("list");
    return;
  }
  listWindow.scrollTo(row);
}

function applyStateToDisplay(state: ClipState): void {
  const stateSegments = "segments" in state ? state.segments : [];
  const stateMeta = "meta" in state ? state.meta : null;
  // idle と failed が持つ範囲は「もう操作できない過去のもの」。画面から消す。
  // failed から RETRY で戻るときは、ready の state/changed が範囲を持ってくる。
  //
  // **別の動画を見ているタブでは取り込まない。** 状態機械の範囲は他の動画の
  // ものなので、覚えてしまうとステータス行に別動画の範囲が出るうえ、
  // 「▶ 区間を見る」でこの動画をその位置へ飛ばしてしまう (canAdjustRange と同じ規則)
  const liveSegments =
    state.kind === "idle" ||
    state.kind === "failed" ||
    stateMeta?.videoId !== currentVideoId()
      ? []
      : stateSegments;

  // 届く前に選んでいた区間。選んでいる区間が変わったか (drifted) を見るためだけに覚える。
  // 時間順の並べ替えで位置が動いても選び続けるのは selectRangeOnNextState の役目
  const previous = selectedSegment();

  busy = BUSY_KINDS.has(state.kind);
  // 欄の押せる / 押せないは refreshLists の中で決まるので、その前に今の種類を書く
  lastKind = state.kind;
  transcriptEditable = acceptsSetClip(state);
  // 欄から送った組の答えが届いたら、待つのをやめる。録画などほかの種類になっても捨てる。
  // 途中の答え (先に送った組) が届いた間は待ち続ける (後から送った組が本当の行き先)
  if (pendingClip !== null && (isClipOf(state, pendingClip) || (state.kind !== "ready" && state.kind !== "idle"))) {
    pendingClip = null;
  }
  // 作り直しの確かめは、状態が届いたらやり直す (確かめた区間とテロップが変わっているかもしれない)
  startOverArmed = false;
  // 投稿した後も範囲を触れる。触ると状態機械が ready へ戻し、
  // 古い範囲のクリップは外れる
  rangeEditable = state.kind === "ready" || state.kind === "posted";
  // 送った範囲の答えが届いたら待つのをやめる。区間を変えられない状態 (録画・失敗・idle など) になっても待たない
  if (rangeAwaiting !== null && (!rangeEditable || liveSegments.some((segment) => sameRange(segment, rangeAwaiting!)))) {
    rangeAwaiting = null;
  }
  currentSegments = liveSegments;
  const previousTelopCount = currentTelops.length;
  currentTelops =
    liveSegments.length === 0 || !("telops" in state) ? [] : state.telops;
  // 最後の区間の削除は UI で止めているが、手元の写しが古くて止め損ねた場合に
  // 黙って消さない
  // **別の動画の状態では言わない。** 削除の応答待ちの間に別の動画へ移ると、取り込まない
  // ので手元は空になるが、状態機械にはまだ残っている。idle は meta を持たないが、
  // そのときは本当に消えている
  const telopsGone =
    removedIndexOnNextState !== null &&
    previousTelopCount > 0 &&
    currentTelops.length === 0 &&
    (stateMeta === null || stateMeta.videoId === currentVideoId());
  if (telopsGone) {
    setStatus("テロップも消えました");
  }
  // 足した・動かした直後は、その範囲の区間を選ぶ (状態機械が時間順に並べるので位置は変わりうる)。
  // それ以外は今の位置を保ち、削除で数が減ったときだけ範囲内へ詰める
  const wanted = selectRangeOnNextState;
  const wantedIndex =
    wanted === null ? -1 : liveSegments.findIndex((segment) => sameRange(segment, wanted));
  if (liveSegments.length === 0) {
    selectedIndex = -1;
  } else if (wantedIndex >= 0) {
    selectedIndex = wantedIndex;
  } else if (selectedIndex < 0) {
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
  const revealSegment = revealSegmentOnNextState;
  const revealTelop = revealLastTelopOnNextState;
  // 欄から送った組の答えを待つ間に、先に送った組の答えが届いた (選びたい区間がまだ無い)。忘れずに次の答えで選ぶ
  if (wantedIndex >= 0 || pendingClip === null) selectRangeOnNextState = null;
  revealSegmentOnNextState = false;
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
  trimPanel?.setEnabled(canAdjustRange());
  refreshOverlay();
  refreshTelopPreview();
  renderActions(state.kind);

  // 失敗はバーにも出す。録画中にタブをリロードした場合、このバーが
  // 唯一の手がかりになる (popup を開かない限り理由が分からない)
  if (state.kind === "failed") {
    setStatus(FAILURE_MESSAGES[state.reason]);
  }

  // 拡大バーを描き直すのは、表示がずれているときだけにする (手を離したときの映し直しは
  // onRangeCommitted がしている。答えが届くたびに描き直すと、続けて動かしている最中に窓が動く)。
  // ただし録画中は、打ち切られたドラッグの見た目が最後の位置に残るため、
  // ずれていなくても確定済みの範囲で描き直す
  refreshLists();
  // 一覧と窓の表示が決まってから送る (出す → 送る の順)
  if (revealSegment) revealInWindow(transcriptPanel?.reveal({ kind: "segment", index: selectedIndex }) ?? null);
  if (revealTelop) {
    const rows = telopList?.element.querySelectorAll<HTMLElement>("[data-role='telop']");
    revealInWindow(rows?.[rows.length - 1] ?? null);
  }

  // 選んでいる区間が変わったら、範囲と秒数を状態の欄に出す (IN / OUT / ＋ 区間を追加の答え)。ready のときだけ:
  // 録画中・プレビュー・失敗などは、それぞれの文言を上で出している
  if (state.kind === "ready" && current !== null && drifted) {
    setStatus(rangeLabel(current));
  } else if (current === null && previous !== null && !telopsGone && state.kind !== "failed") {
    // 区間が無くなった (消した・idle に戻った・別の動画へ移った)。書いた範囲を残すと、別の動画のバーに前の動画の
    // 範囲が出続ける。最初の案内に戻す。「テロップも消えました」と失敗の文言は上で出しているので上書きしない
    setStatus(INITIAL_STATUS);
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
  if (range === null) return;
  await playSpan(range, range.startSec, range.endSec, `区間を再生中… (${Math.round(range.endSec - range.startSec)}秒)`);
}

/**
 * 繋ぎ目だけを聞き直す (第 2 版のモック)。in = 頭の 2 秒前から頭の 2 秒後まで、out = 尻の 2 秒前から尻の 2 秒後まで
 * (切り落とした所も聞こえる)。尻の 2 秒後が動画の終わりを越えても、`onReachTime` が `ended` で止める
 */
async function playAround(kind: HandleKind): Promise<void> {
  const range = selectedSegment();
  if (range === null) return;
  const edge = kind === "in" ? range.startSec : range.endSec;
  const fromSec = Math.max(0, edge - TRIM_MARGIN_SEC);
  const label = kind === "in" ? "頭の 2 秒前から再生中…" : "尻をまたいで再生中…";
  await playSpan(range, fromSec, edge + TRIM_MARGIN_SEC, label);
}

/**
 * fromSec から toSec まで再生して止める。止めたら区間の範囲を状態の欄に戻す
 */
async function playSpan(range: ClipRange, fromSec: number, toSec: number, playingLabel: string): Promise<void> {
  if (busy) return;
  cancelPreviewWatch();
  const video = await seekAndPlay(fromSec);
  if (video === null) return;

  try {
    setStatus(playingLabel);
    cancelPreview = onReachTime(video, toSec, () => {
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
    setStatus(`区間を再生できませんでした: ${String(error)}`);
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
  // seek を待つ間にオフにして中止が通ったら、SEEK_DONE を送らない (オフの間は何も送らない。spec §1)
  const id = runId;
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
    if (!isCurrentRun(id)) return;

    send({ type: "SEEK_DONE" });
    setStatus(`${qualityNote}録画の準備をしています…`);
  } catch (error) {
    if (!isCurrentRun(id)) return;
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
  // 録画の準備 (startRecording) を待つ間にオフにしたかを見る (isCurrentRun)
  const id = runId;
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
        notifyOutcome({ type: "recorder/failed", reason: error.message });
      },
    });
    // 録画の準備を待っている間に片付いた (オフにして中止が通った)。始まった録画はここで捨てる。残すと、オフのページで
    // MediaRecorder と captureStream が回り続ける (spec §1)。合成は録画の解放に繋がっているので一緒に止まる
    if (!isCurrentRun(id)) {
      abortRecording();
      return;
    }
    void notify({ type: "recorder/started" });
  } catch (error) {
    // release は二度呼んでも安全 (startRecording の中で解放済みのことがある)
    videoOverride?.release();
    // 録画の準備を待っている間に片付いた (オフにして中止が通った)。状態機械はもう ready に戻っているので、失敗を伝えて
    // failed に落とさない。オフのページから送らない (spec §1)
    if (!isCurrentRun(id)) return;
    notifyOutcome({ type: "recorder/failed", reason: String(error) });
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
  const id = runId;
  try {
    const video = getVideo();
    await startPlayback(video);
    // 再生を待つ間にオフにして中止が通ったら、OUT の監視 (rVFC) をオフのページに張らない
    if (!isCurrentRun(id)) return;
    watchSegmentEnd(video, segments, 0);
  } catch (error) {
    if (!isCurrentRun(id)) return;
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
  // 継ぎ目の seek と再生を待つ間にオフにして中止が通ったら、続きを走らせない (isCurrentRun)
  const id = runId;
  try {
    recorder.pause();
    video.pause();
    setStatus(`${index + 1} / ${segments.length} 区間目へ移動中…`);

    await seekTo(video, segment.startSec);
    // オフのページで再生を始めない・waitForFreshFrame の rVFC を張らない (spec §1)。下の handle の確かめは
    // waitForFreshFrame の後なので、それより前で断つ
    if (!isCurrentRun(id)) return;
    await startPlayback(video);
    if (!isCurrentRun(id)) return;
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
    // オフにした後の seek の失敗 (時間切れ) を service worker へ送らない (オフの間は 0 件。spec §1)
    if (!isCurrentRun(id)) return;
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`${FAILURE_MESSAGES["seek-failed"]}: ${String(error)}`);
  }
}

/** 録画を止めて結果を送る。拡張の IndexedDB は content script から触れない */
async function finishRecording(): Promise<void> {
  if (handle === null) {
    notifyOutcome({ type: "recorder/failed", reason: "録画が開始されていません" });
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

    notifyOutcome({
      type: "recorder/done",
      base64: encodeBase64(bytes),
      mimeType: blob.type,
    });
  } catch (error) {
    notifyOutcome({ type: "recorder/failed", reason: String(error) });
  }
}

/**
 * popup の設定に渡すチャンネル (`channel/get` の応答。settings-in-popup spec §2)。**問われるたびに読む**
 * (SPA 遷移で別のチャンネルへ移る)。動画の再生画面以外では null (前の動画のチャンネルを答えない)。
 *
 * `getChannel` は見つからなくても throw しないので、ここに try/catch は要らない
 */
function readChannel(): Channel | null {
  if (currentVideoId() === null) return null;
  const channel = getChannel();
  // ID が取れないチャンネルは設定の鍵にできない。入力させない
  return channel.id === "" ? null : channel;
}

/**
 * 区間を消す (欄の見出しの ✕)。**テロップが残っている間は最後の 1 区間を消させない。** 区間が 0 個に
 * なると状態機械は idle に戻り、手入力の文言もまとめて消える
 */
function removeSegment(index: number): void {
  if (busy) return;
  if (index < 0 || index >= currentSegments.length) return;
  if (currentSegments.length === 1 && currentTelops.length > 0) {
    setStatus(telopsRemainMessage(currentTelops.length));
    return;
  }
  removedIndexOnNextState = index;
  send({ type: "REMOVE_SEGMENT", index });
}

/** 欄の見出し・詰める欄の ‹ › で区間を選んだ。その区間を詰める (録画中は選び直さない) */
function selectSegment(index: number): void {
  if (busy) return;
  if (index < 0 || index >= listedItems().segments.length) return;
  selectedIndex = index;
  applyStateToSelection();
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
  const addButton = makeButton("＋ 区間を追加", false, onAddSegment);
  const inButton = makeButton("IN", false, onMarkIn);
  const outButton = makeButton("OUT", false, onMarkOut);
  const playButton = makeButton("▶ 区間を見る", false, () => void playRange());

  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.style.cssText = BAR_STYLE.status;
  status.textContent = INITIAL_STATUS;
  status.title = status.textContent;

  // 状態ごとに中身を入れ替える箱。押しても拒まれるだけの操作は出さない
  const actions = document.createElement("div");
  actions.id = ACTIONS_ID;
  actions.style.cssText = BAR_STYLE.row;

  // つまみは左端。その後は「追加してから頭と尻を決める」順に並べる
  row.append(grip, addButton, inButton, outButton, playButton, actions, status);

  // 拡大バーは生成直後は無効。範囲が確定して ready になったら有効化される
  rangeBar = createRangeBar({
    onScrub,
    onCommit: onRangeCommitted,
    onSeekPlay: (sec) => void onSeekPlay(sec),
    maxClipSec: () => maxClipSec,
    // 吸い付き先は今の動画の文字起こしの単語の切れ目 (別の動画の行は transcriptLines が返さない)
    snapPoints: (window) => snapPointsIn(transcriptLines(), window),
    onGrab: (kind) => trimPanel?.setActiveEdge(kind),
  });
  rangeBar.element.id = RANGE_ID;

  // 拡大バーの下のテロップの帯。拡大バーと同じ時間の軸で描くので、拡大バーと一緒に作り直す。
  // ドラッグ中のシークは拡大バーと同じ onScrub、押して離したときは一覧の ▶ と同じ再生
  telopTrack = createTelopTrack({
    onScrub,
    onCommit: onTelopDragged,
    onPlay: (index) => void playTelop(index),
  });

  // 詰める欄 (第 2 版のモック)。拡大バーとテロップの帯はここに入る
  trimPanel = createTrimPanel(
    { rangeBar: rangeBar.element, telopTrack: telopTrack.element },
    {
      onSelect: selectSegment,
      onNudge,
      onPlayAround: (kind) => void playAround(kind),
    },
  );

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

  // 文字起こしの欄 (ADR 0001)。区間・テロップの窓の先頭に置く。区間とテロップの一覧は 1c まで欄の下に残す
  // 欄は 1 度だけ作る。バーの根が YouTube の再描画で外れて buildBar が走るたびに、数千行を作り直さない
  transcriptPanel ??= createTranscriptPanel({
    onToggle: onToggleLine,
    onEditText: onEditLineText,
    onToggleHidden: onToggleLineHidden,
    onPlay: onPlayLine,
    onSelectSegment: selectSegment,
    onRemoveSegment: removeSegment,
    onAddManual: () => undefined,
    onManualEdge: () => undefined,
    onManualText: () => false,
    onRemoveManual: () => undefined,
    onPlayManual: () => undefined,
    onRetry: () => transcriptLoader?.retry(),
  });

  // バーは詰める欄 (見出しの行 → 拡大バー → テロップの帯の段 → 単語) → 操作の行。拡大バーは幅がそのまま精度になるので、
  // 一覧の窓の幅には縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の
  // spec A.1)。帯の段は拡大バーのトラックの**下**に置く: トラックの中に重ねると、区間のハンドルと
  // 帯の当たり判定が重なる (spec B.1)
  bar.append(trimPanel.element, row);
  // 一覧は区間・テロップの窓へ (窓の分割の spec C1.4)。**中身ごと入れ替える。**
  // 足すだけにすると、バーを作り直すたびに古い一覧が残って 2 重になる
  listWindow.body.replaceChildren(transcriptPanel.element, telopList.element);
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
      const time = getVideo().currentTime;
      rangeBar?.setPlayhead(time);
      transcriptPanel?.setCurrentTime(time);
    } catch {
      // 動画要素がまだ無いか差し替えの最中。位置を示しようがないので消す。
      // ここで投げると監視が止まり、以降ずっと更新されなくなる
      rangeBar?.setPlayhead(null);
    }
    playheadFrame = requestAnimationFrame(step);
  };
  playheadFrame = requestAnimationFrame(step);
}

/**
 * 再生位置のループを止める (stop())。今までは止める口が無かった (content script はページと一緒に消えるだけだった)。
 * 次の start() の mount が張り直す
 */
function stopPlayheadWatch(): void {
  if (playheadFrame !== 0) cancelAnimationFrame(playheadFrame);
  playheadFrame = 0;
  playheadWatched = false;
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
/** プレイヤーの大きさの変化 (シアターモードの切り替えなど) を拾う。オンの間だけある (start() が作り、stop() が外す) */
let playerObserver!: ResizeObserver;

function watchPlayerSize(): void {
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === observedPlayer) return;
  playerObserver.disconnect();
  observedPlayer = player;
  if (player !== null) playerObserver.observe(player);
}

/** 文字起こしの用意 (ADR 0002)。オンの間だけある (start() が作り、stop() が外す) */
let transcriptLoader: TranscriptLoader | null = null;
/** 文字起こしの欄 (区間・テロップの窓の先頭)。バーと一緒に buildBar が作り直す */
let transcriptPanel: TranscriptPanel | null = null;
/** 文字起こしの最新の状態 (loader から)。欄を描き直すときに読む */
let transcriptStatus: TranscriptStatus = { kind: "idle" };
/** 直前に押した行 (Shift + クリックの起点) */
let anchorLineId: string | null = null;
/** 欄から送ったけれど、状態機械の答えがまだ届いていない組 (clipBase の doc) */
let pendingClip: Clip | null = null;
/** 外した行のテロップの文字 (行の id ごと)。入れ直したら戻す。動画が変わったら捨てる */
const editedLineTexts = new Map<string, string>();
/** 届いた状態が SET_CLIP を受けるか (acceptsSetClip)。欄の押せる / 押せないはこれで決める */
let transcriptEditable = true;

/**
 * 文字起こしの状態が変わった。欄を描き直し、結末をコンソールに 1 行残す
 * (確かめ方は docs/manual-check.md の「文字起こし (公式字幕)」)。オフの後に届いたものは出さない
 */
function onTranscriptStatus(status: TranscriptStatus): void {
  if (!running) return;
  transcriptStatus = status;
  const line = transcriptLogLine(status);
  if (line !== null) console.info(line);
  refreshTranscript();
}

/** 今の動画の文字起こしの行を id で引く */
function lineById(id: string): TranscriptLine | undefined {
  return transcriptLines().find((line) => line.id === id);
}

/** 今の動画の文字起こしの行。今の動画のものでなければ空 */
function transcriptLines(): TranscriptLine[] {
  const status = transcriptStatus;
  return status.kind === "ready" && status.videoId === currentVideoId() ? status.transcript.lines : [];
}

/**
 * 文字起こしの欄で区間を変えてよいか。状態機械の SET_CLIP と同じ規則 (acceptsSetClip)。**今届いた状態で見る**
 * (applyStateToDisplay は refreshLists より前に transcriptEditable を書く)
 */
function canEditFromTranscript(): boolean {
  return transcriptEditable;
}

/**
 * 欄の操作の元にする区間とテロップ。**送ったけれど答えがまだ来ていない組があれば、それを元にする。**
 * SET_CLIP は丸ごと差し替えるので、答えを待つ間にもう 1 行押したとき、手元の写しから作ると先に押した行が消える
 * (service worker が寝ていると答えまで数百 ms かかる)。描くのは今までどおり状態機械の答えが届いてから
 */
function clipBase(): Clip {
  return pendingClip ?? listedItems();
}

function sameTelop(a: Telop, b: Telop): boolean {
  return a.startSec === b.startSec && a.endSec === b.endSec && a.text === b.text && a.lineId === b.lineId;
}

/** 届いた状態が、送った組そのものか (区間が空なら idle)。区間は状態機械も時間順に並べるので、並びのまま比べる */
function isClipOf(state: ClipState, clip: Clip): boolean {
  if (clip.segments.length === 0) return state.kind === "idle";
  return (
    state.kind === "ready" &&
    state.segments.length === clip.segments.length &&
    state.telops.length === clip.telops.length &&
    state.segments.every((segment, i) => sameRange(segment, clip.segments[i]!)) &&
    state.telops.every((telop, i) => sameTelop(telop, clip.telops[i]!))
  );
}

/**
 * 欄から組を送る。拒まれたら (別の経路で録画に入った後など) 「受け付けられませんでした」を出し、待つ組を捨てる。
 * **届かなかったときも捨てる** (残ると、＋ 区間を追加などほかの経路の結果を、欄の次の操作が上書きする)
 */
function sendClip(next: Clip): void {
  pendingClip = next;
  cancelPreviewWatch();
  const drop = (): void => {
    if (pendingClip === next) pendingClip = null;
  };
  send(
    { type: "SET_CLIP", segments: next.segments, telops: next.telops, meta: getVideoMeta() },
    (state) => {
      const ok = isClipOf(state, next);
      if (!ok) drop();
      return ok;
    },
    drop,
  );
}

/** 欄の見出し。今の動画のものでなければ、取っている間と同じに見せる */
function transcriptHeader(status: TranscriptStatus, forThisVideo: boolean): TranscriptView["header"] {
  if (!forThisVideo) return { kind: "loading" };
  switch (status.kind) {
    case "ready":
      return { kind: "ready", label: TRANSCRIPT_SOURCE_LABEL[status.transcript.source] };
    case "none":
      return { kind: "none" };
    case "failed":
      return { kind: "failed", reason: status.reason };
    default:
      return { kind: "loading" };
  }
}

/** 欄を今の状態で描き直す。区間に入っているかは状態機械の区間から決める (欄は選択を持たない) */
function refreshTranscript(): void {
  if (transcriptPanel === null) return;
  const status = transcriptStatus;
  // 前の動画の知らせ (吹き替え・字幕が無い・取れなかった) を、別の動画へ移った直後に出さない
  const forThisVideo = status.kind !== "idle" && status.videoId === currentVideoId();
  const { segments, telops } = listedItems();
  const lines = transcriptLines();
  const telopByLine = new Map(telops.filter((telop) => telop.lineId !== undefined).map((telop) => [telop.lineId, telop]));
  const header = transcriptHeader(status, forThisVideo);
  transcriptPanel.update({
    header,
    dubbed: forThisVideo && (status.kind === "ready" || status.kind === "none") && status.dubbed,
    enabled: canEditFromTranscript(),
    // 区間の見出し。手入力の行は Task 4 で繋ぐ (それまではテロップの一覧が出す)
    items: placeTranscriptItems(lines, segments, []),
    trimmingIndex: segments.length === 0 ? -1 : selectedIndex,
    canAddManual: false,
    rows: lines.map((line) => {
      const selected = isLineInSegments(line, segments);
      const telop = telopByLine.get(line.id);
      return {
        id: line.id,
        startSec: line.startSec,
        text: selected && telop !== undefined && telop.text !== "" ? telop.text : line.text,
        selected,
        hidden: selected && telop !== undefined && telop.text === "",
        hasTelop: selected && telop !== undefined,
      };
    }),
  });
  // 読み込みが済んだら詰める欄にも単語を出す (refreshLists からも呼ばれるので 2 回になるが冪等)
  refreshTrimPanel();
}

/** 動画の長さ。分からなければ Infinity (区間の尻を止めない) */
function videoDurationSec(): number {
  const duration = getVideo().duration;
  return Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
}

/** 行を押した。入っていれば外し、入っていなければ入れる。Shift なら直前に押した行からまとめて */
function onToggleLine(lineId: string, extend: boolean): void {
  if (!canEditFromTranscript()) {
    // 録画中は「録画中… (N秒)」を上書きしない (欄が薄いことで押せないと分かる)
    if (!busy) setStatus("いまは区間を変えられません");
    return;
  }
  const lines = transcriptLines();
  const line = lines.find((item) => item.id === lineId);
  if (line === undefined) return;
  // 別の動画の区間は持ち越さない (listedItems は別の動画では空を返す)
  const base = clipBase();
  const selected = !isLineInSegments(line, base.segments);
  const ids = extend && anchorLineId !== null ? lineIdsBetween(lines, anchorLineId, lineId) : [lineId];
  const next = setLinesSelected(base, lines, ids, selected, videoDurationSec());
  // 1 つの区間が上限を超えるなら送らない。拡大バーは 1 区間を上限より長くできず、つまみが跳ぶ (clampHandle)
  const tooLong = next.segments.find(
    (segment) => segment.endSec - segment.startSec > maxClipSec && !base.segments.some((old) => sameRange(old, segment)),
  );
  if (tooLong !== undefined) {
    setStatus(`1 つの区間は ${maxClipSec} 秒までです。行を分けて選んでください (設定で上限を変えられます)`);
    return;
  }
  // **最後の区間が消えるとき、テロップが残るなら送らない** (区間の一覧の ✕ と同じ守り)。区間が 0 個になると
  // 状態機械は idle に戻り、手で打ったテロップもまとめて消える
  if (next.segments.length === 0 && next.telops.length > 0) {
    setStatus(telopsRemainMessage(next.telops.length));
    return;
  }
  // 起点は送るときだけ動かす (拒んだ Shift + クリックで起点がずれない)
  anchorLineId = lineId;
  // 外した行の直した文字を覚え、入れ直したら戻す (続けて 2 回押すと、外して入れ直すことになる)
  const pickedIds = new Set(ids);
  if (!selected) {
    for (const telop of base.telops) {
      if (telop.lineId !== undefined && pickedIds.has(telop.lineId)) editedLineTexts.set(telop.lineId, telop.text);
    }
  }
  const telops = selected
    ? next.telops.map((telop) => {
        const remembered = telop.lineId === undefined || base.telops.includes(telop) ? undefined : editedLineTexts.get(telop.lineId);
        return remembered === undefined ? telop : { ...telop, text: remembered };
      })
    : next.telops;
  // 押した行を含む区間を選ぶ (拡大バーがその区間になる)
  const holding = next.segments.find((segment) => isLineInSegments(line, [segment]));
  if (holding !== undefined) selectRangeOnNextState = holding;
  sendClip({ segments: next.segments, telops });
}

/** 行の文字を直した。その行のテロップの文字にする (送らなかったら false。直す欄を閉じない) */
function onEditLineText(lineId: string, text: string): boolean {
  if (!canEditFromTranscript()) return false;
  if (rejectLongTelopText(text)) return false;
  const base = clipBase();
  if (!base.telops.some((telop) => telop.lineId === lineId)) return false;
  sendClip({
    segments: base.segments,
    telops: base.telops.map((telop) => (telop.lineId === lineId ? { ...telop, text } : telop)),
  });
  return true;
}

/** 「字幕に出さない」/「字幕に出す」 */
function onToggleLineHidden(lineId: string): void {
  if (!canEditFromTranscript()) return;
  const line = lineById(lineId);
  if (line === undefined) return;
  const next = toggleTelopHidden(clipBase(), line);
  if (next === null) return;
  sendClip(next);
}

/**
 * 行の時刻を押した。その行の頭から再生する。**録画中は動かさない** (録画が壊れる。playTelop と同じ)。
 * 録画中は「録画中… (N秒)」を上書きしないよう、何も言わない
 */
function onPlayLine(lineId: string): void {
  if (busy) return;
  const line = lineById(lineId);
  if (line === undefined) return;
  void onSeekPlay(line.startSec);
}

function mount(): void {
  const videoId = currentVideoId();
  // 動画ページ以外ではページに何も差さない (C2.7 の spa-inject の追記)。バーも組み立てない (タイトルもプレイヤーも無い)
  if (videoId === null) {
    refreshWindows();
    return;
  }
  // 文字起こしを用意する (ADR 0002)。同じ動画なら loader が何もしない (mount は DOM の変化のたびに呼ばれる)
  transcriptLoader?.load(videoId);
  // ドック枠を差す先に付け直す (C2.7)。YouTube が子を作り直すと枠ごと外れる。使えるかが変わったら
  // (1 列表示になった・戻った・差す先が消えた) 窓を出し直す (退避 / 枠へ戻す)。**バーの有無より先に見る**
  if (dockManager.attach(dockAnchors())) refreshWindows();
  // 浮いた窓を body の直下に置く。**バーの有無より先に見る**
  attachWindowsToBody();
  // **バーの有無より先に見る。** バーを作り直さなくても、プレイヤーの要素だけが替わることがある
  watchPlayerSize();
  // 再生位置の監視も同じ。動画ページ以外へ移ると leaveVideoPage が止めるので、戻ったとき (バーは残っている) に張り直す
  if (!playheadWatched) {
    playheadWatched = true;
    watchPlayhead();
  }
  // 出す判断 (refreshWindows) と同じく、窓の中に中身があるかで見る (barPart)
  if (barPart(BAR_ID) !== null) return;

  // #below に置くのはドック枠だけ (C2.1。15 行上の dockManager.attach が先頭に差している)。
  // 中身の根 (BAR_ID) は置かない。「動画ページのページができたか」の目印としては引き続き #below を見る
  // (spec A.3 / C2.1)。まだ無い間にバーを作ると、タイトルもプレイヤーも読めないまま IN を押せる
  const anchor = document.querySelector(YT_SELECTORS.mountAnchor);
  if (anchor === null) {
    // 中身の根 (BAR_ID) が無いままここで抜けると、バーの窓が中身の無いまま出続けることがある。
    // refreshWindows は中身の根が無ければバーの窓を隠すので、ここで一度呼んでおく
    refreshWindows();
    return; // 動画ページ未生成。次の observe で再試行する
  }

  // 前のバーが外されていることがある (YouTube の再描画で枠ごと外れた)。参照だけ差し替えると
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

  // 作り直したバーは空で無効の状態。確定済みの範囲があれば載せ直す
  rangeBar?.setEnabled(canAdjustRange());
  trimPanel?.setEnabled(canAdjustRange());
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
function onRuntimeMessage(
  message: Message,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): void {
  // 外し損ねたときの防御 (マスタースイッチの spec §8)。stop() が listener を外すので普段は来ない。来ても、片付けた
  // 窓・帯・canvas を描き直さない
  if (!running) return;
  // popup の設定がハッシュタグの鍵にするチャンネル (settings-in-popup spec §2)。オフの間は listener ごと無いので、
  // popup には「受け手が居ない」で返る (= チャンネルを特定できない)
  if (message.type === "channel/get") {
    sendResponse({ channel: readChannel() } satisfies ChannelResponse);
    return;
  }
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

  // state/changed は録画対象のタブにしか届かない (router は captureTabId にだけ同報する)。busy の間は、このタブで
  // 録画の準備・録画・書き出しが走っている (capturing の doc。判断メモ 13)
  const nextCapturing = BUSY_KINDS.has(message.state.kind);
  if (nextCapturing && !capturing) captureRun += 1;
  capturing = nextCapturing;
  handleStateChanged(message.state);
  // 状態を処理し終えた。オフを待っていたなら、ここで片付けてよくなったかもしれない (spec §4.1)
  driver.reconcile();
}

/** 状態の通知を画面と録画に反映する (onRuntimeMessage の state/changed) */
function handleStateChanged(state: ClipState): void {
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
}

/**
 * オフにしたが、このタブで録画が走っているので stop を待たされた (driver が待ちに入るたびに 1 回呼ぶ。spec §4.1)。
 *
 * - seeking / recording: 中止 (CANCEL_RECORDING) を送る。バーの「■ 中止」と同じ経路で、区間とテロップは残り ready に戻る
 * - encoding: 何もしない。**書き出しが終わるまで待つ**: ここで録画を捨てると recorder/done が送られず、service worker が
 *   encoding で固まる。書き出しの結末を送り終えたら notifyOutcome が reconcile する
 */
function onStopDeferred(): void {
  if (lastKind !== "seeking" && lastKind !== "recording") return;
  cancelForSwitch();
}

/**
 * オフのための中止を送る。**応答の状態が busy でなければ、state/changed を待たずに片付ける** (判断メモ 1): router の同報は
 * 送りっぱなしで、届かなかったときに永久に待たないため。state/changed (ready) が先に届けば、そちらで片付く。
 * 中止が拒まれた (既に encoding へ進んでいた) ときは応答が busy のままなので、書き出しの結末を待つ。
 * 送れなかった (拡張が読み込み直されて受け手が居ない) ときは、待っても結末は届かないので片付ける
 */
function cancelForSwitch(): void {
  const id = runId;
  const run = captureRun;
  /**
   * この応答が古くなったか (判断メモ 33)。オフ → オンで作り直した後か、送った後に別の録画が始まった (オフを待つ間に
   * オンへ戻して録り直した) なら、新しい録画の状態が正なので応答で旗を下ろさない。同じ録画の中の seeking → recording
   * の進みでは捨てない (応答の口は同報が失われても片付くためにある。判断メモ 1)
   */
  const stale = (): boolean => !isCurrentRun(id) || captureRun !== run;
  void chrome.runtime
    .sendMessage({
      type: "clip/event",
      event: { type: "CANCEL_RECORDING" },
    } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (stale()) return;
      if (response !== undefined && !BUSY_KINDS.has(response.state.kind)) endCapture();
    })
    .catch((error: unknown) => {
      if (stale()) return;
      setStatus(`操作を送信できませんでした: ${String(error)}`);
      endCapture();
    });
}

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
  // 応答が届くまでにオフにしたら画面に触らない (isCurrentRun の doc)
  const id = runId;
  void chrome.runtime
    .sendMessage({ type: "content/loaded" } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (!isCurrentRun(id)) return;
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
      // オフにした後の失敗はコンソールにも出さない (オフの間の出力は 0 行。spec §1)
      if (!isCurrentRun(id)) return;
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
  // 読み終えるまでにオフにしたら、読んだ値を使わない
  const id = runId;
  void loadSettings()
    .then((settings) => {
      if (!isCurrentRun(id)) return;
      maxClipSec = settings.maxClipSec;
      applyTelopSettings(settings);
    })
    .catch((error: unknown) => {
      if (!isCurrentRun(id)) return;
      console.warn(`設定を読めませんでした: ${String(error)}`);
    });
}

/**
 * 起動時に覚えた窓の配置 (浮いた窓の位置と、どの枠に入れたか) を読む。**済むまで窓も枠も出さない**
 * (refreshWindows が layoutReady を見る。枠は窓が隠れていれば隠れる)。
 *
 * 覚えた位置も画面に収まるよう詰めてから使う (place が詰める。大きい画面で覚えた位置を
 * 小さい画面で開いたとき)。読めなくても最初の位置で出す (loadWindowLayout は失敗を warn して
 * 空を返す。spec A.2)
 */
function loadInitialLayout(): void {
  // 読み終えるまでにオフにしたら、窓を置かない・出さない (layoutReady を立てると refreshWindows が窓を出す)
  const id = runId;
  void loadWindowLayout()
    .then((layout) => {
      if (!isCurrentRun(id)) return;
      // 枠の中身を先に入れる。窓を枠へ置くのは下の refreshWindows の sync (出す条件が決まってから)。
      // **読み込みは保存しない** (load は onChange を呼ばない。C1.3)
      dockManager.load(layout.docks);
      for (const id of WINDOW_IDS) {
        const rect = layout.float[id];
        if (rect === undefined) continue;
        // 写しを書き換える 3 箇所の 1 つ (floatLayout の doc)
        floatLayout[id] = rect;
        // float と docks の両方にある窓は枠を採る (C2.6)。float は引き出したときの大きさにだけ使うので、
        // 写しには入れ、位置は当てない
        if (dockManager.slotOf(id) !== null) continue;
        windowOf(id).place(rect);
      }
    })
    .catch((error: unknown) => {
      if (!isCurrentRun(id)) return;
      // 窓を置けないのは想定外。それでも出さないままにはしない (spec A.2)
      console.warn(`覚えた窓の位置を使えませんでした: ${String(error)}`);
    })
    .finally(() => {
      if (!isCurrentRun(id)) return;
      layoutReady = true;
      refreshWindows();
    });
}

/**
 * 設定は**別のタブで変えられる**。保存ボタンに繋ぐだけでは、開いたままの
 * タブが古い上限のまま残り、そのタブでだけ録画の長さが違うことになる。
 *
 * **通知が新しい値を持っているので読み直さない。** ここで loadSettings すると、
 * 設定を 1 回保存するたびに、開いている YouTube タブの数だけ storage を
 * 往復することになる (書いた当のタブでも発火する)。
 * オンの間だけ張る (start() が張り、stop() が外す)。スイッチの見張り (switch-driver) とは別の listener
 */
function onSettingsChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  const change = areaName === "sync" ? changes[SETTINGS_KEY] : undefined;
  if (change === undefined) return;
  const settings = mergeSettings(change.newValue);
  maxClipSec = settings.maxClipSec;
  applyTelopSettings(settings);
}

/** 直前に見ていた URL。SPA 遷移の検出に使う。start() が読み直す */
let lastHref = location.href;
/**
 * 直前に見ていた URL が動画ページか。DOM の変化のたびに URL を解かないための写し (lastHref と一緒に書く)。
 * ホームや検索結果では body の変化が多いので、URL が変わっていなければ先頭で抜ける
 */
let lastHrefIsVideoPage = false;

/**
 * テーマの切り替えに追従する。YouTube は <html dark> を付け外しするだけで
 * 画面を作り直さないため、DOM 変化の監視では拾えない
 */
function onThemeChanged(): void {
  const dark = isDarkTheme();
  const bar = barPart(BAR_ID);
  if (bar !== null) applyPalette(bar, dark);
  // 窓は body の直下にある。ページの配色は継がれない
  applyPalette(barWindow.element, dark);
  applyPalette(listWindow.element, dark);
  // ドック枠 (タブの列と目印) も自前の配色
  for (const slot of Object.values(dockManager.elements)) applyPalette(slot, dark);
}

/** テーマ (<html dark>) の監視。オンの間だけある */
let themeObserver!: MutationObserver;

/** YouTube は SPA 遷移するため DOM 変化を監視して再マウントする */
function onPageMutated(): void {
  if (location.href !== lastHref) {
    // 前の動画の行の起点と直した文字を持ち越さない。同じ動画で URL だけ変わったとき (&t= など) は捨てない
    // (捨てると、答えを待つ間に先に押した行が消える)
    const previousVideoId = videoIdOf(lastHref);
    lastHref = location.href;
    if (currentVideoId() !== previousVideoId) {
      anchorLineId = null;
      pendingClip = null;
      editedLineTexts.clear();
    }
    lastHrefIsVideoPage = currentVideoId() !== null;
    // 動画ページへ戻ったら、外していた窓を先に body へ戻す。下の refreshLists が窓を出した直後に最初の位置を
    // 取り直す (placeInitial) ので、文書に無い窓 (寸法 0) を測らせない
    if (lastHrefIsVideoPage) attachWindowsToBody();
    // 別の動画へ移ったら、範囲も帯もこの画面のものではなくなる。帯を残すと
    // 旧動画の位置に青い帯が出たままになり、ハンドルを動かせてしまうと
    // 見えていない動画の範囲を書き換えることになる
    rangeBar?.setEnabled(canAdjustRange());
    trimPanel?.setEnabled(canAdjustRange());
    refreshOverlay();
    refreshTelopPreview();
    // 一覧も同じ規則で描き直す。区間・テロップの窓に A の区間が B の画面で出続けないように。
    // 動画ページ以外へ移ったら、窓もドック枠もページから外れる (refreshWindows → leaveVideoPage)
    refreshLists();
    // 状態の欄も同じ。B では最初の案内、A へ戻ったら選んでいる区間の範囲 (状態は SPA で移っても届かない)。
    // 録画中と失敗の文言は上書きしない (それぞれの経路が出している)
    if (!busy && lastKind !== "failed") {
      const segment = selectedSegment();
      setStatus(segment !== null && rangeVideoId === currentVideoId() ? rangeLabel(segment) : INITIAL_STATUS);
    }
  } else if (!lastHrefIsVideoPage) {
    // 動画ページ以外で URL が変わっていない。外すものは移ったときに外してある (ホームの DOM の変化で毎回何もしない)
    return;
  }
  mount();
}

/** body の子孫の監視 (SPA 遷移と再描画)。オンの間だけある */
let pageObserver!: MutationObserver;

/**
 * モジュールの状態を最初の値に戻す (stop() の最後。spec §2.2)。**状態機械が正で、ここにあるのは写し**なので、戻しても
 * 失うものは無い (次の start() の content/loaded の応答と、覚えた配置の読み直しで取り戻す)。
 *
 * **設定から読んだ値 (maxClipSec / telopStyle) は戻さない** (判断メモ 8)。start() の loadInitialSettings が読み直す
 * ので値は同じになる
 */
function resetModuleState(): void {
  currentSegments = [];
  currentTelops = [];
  recordingTelops = null;
  selectedIndex = -1;
  telopList = null;
  rangeBar = null;
  telopTrack = null;
  trimPanel = null;
  layoutReady = false;
  // 覚えた配置の写し。start() の loadInitialLayout が読み直す (オフの間に別のタブで動かした位置も拾う)
  for (const id of WINDOW_IDS) delete floatLayout[id];
  lastKind = "idle";
  startOverArmed = false;
  selectRangeOnNextState = null;
  rangeAwaiting = null;
  revealSegmentOnNextState = false;
  revealLastTelopOnNextState = false;
  removedIndexOnNextState = null;
  rangeVideoId = null;
  busy = false;
  rangeEditable = false;
  transcriptPanel = null;
  transcriptStatus = { kind: "idle" };
  anchorLineId = null;
  pendingClip = null;
  editedLineTexts.clear();
  transcriptEditable = true;
  cancelWatch = null;
  cancelPreview = null;
  handle = null;
  observedPlayer = null;
  capturing = false;
  captureRun = 0;
}

/**
 * オンにする (マスタースイッチの spec §2.3 の逆順)。今まで import 時に行っていた処理を、そのままここで行う:
 * 窓とドック枠と監視を作る → mount() → 設定の読み込み → 覚えた配置の読み込み → content/loaded (状態の取り戻し)。
 * **読み込み直さずにオンへ戻せる** (spec §2.4): content/loaded はタブのリロードと同じ経路で、応答の状態で範囲・帯・一覧が
 * 戻る。覚えた配置の読み込みが済むまで窓を出さない (spec A.2) のも今までと同じ。
 * 呼ぶのは switch driver だけ (テストのために export する。判断メモ 15)。二度呼ぶのは配線の誤り
 */
export function start(): void {
  if (running) throw new Error("[yt-clip] start() を二度呼びました (配線の誤り)");
  running = true;
  runId += 1;
  createWindows();
  telopPreview = createTelopPreview();
  playerObserver = new ResizeObserver(() => placeUnmovedWindows());
  // 状態の通知と設定の変更。stop() が先に外す (以後の通知で、片付けた要素を触りに行かない)
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onSettingsChanged);
  lastHref = location.href;
  lastHrefIsVideoPage = currentVideoId() !== null;
  themeObserver = new MutationObserver(onThemeChanged);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["dark"],
  });
  // 全画面の間は窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
  document.addEventListener("fullscreenchange", refreshWindows);
  // ブラウザの大きさが変わったら、動かしていない窓の最初の位置を取り直す (spec A.2)。
  // 動かした窓は置いた場所のまま (画面の外へ出る分は窓の枠が自分で詰める)
  window.addEventListener("resize", placeUnmovedWindows);
  pageObserver = new MutationObserver(onPageMutated);
  pageObserver.observe(document.body, { childList: true, subtree: true });
  transcriptLoader = createDefaultTranscriptLoader(onTranscriptStatus);
  mount();
  loadInitialSettings();
  loadInitialLayout();
  recoverFromState();
}

/**
 * オフにする (マスタースイッチの spec §2.2 / §2.3)。ページに足したもの・張った listener と監視・走っているループを
 * すべて外し、モジュールの状態を最初の値に戻す。**覚えた配置 (local の windowLayout) と設定 (sync の settings) は消さない**
 * (オフ → オンで窓は前と同じ位置・同じ枠に出る)。スイッチを見張る listener は switch driver が持つので残る。
 * 呼ぶのは switch driver だけ。走っていないのに呼ぶのは配線の誤り
 */
export function stop(): void {
  if (!running) throw new Error("[yt-clip] 走っていないのに stop() を呼びました (配線の誤り)");
  // 先に下ろす。この後に届く非同期の続き (storage の読み・応答・seek の完了) は isCurrentRun で何もしない (判断メモ 12)
  running = false;
  runId += 1;
  // 1. 範囲再生の監視・録画の監視・録画。このタブで録画が走っていないことは driver の canStop が保証する
  //    (spec §4.1)。ここで止まるのは範囲再生の監視だけのはず
  cancelPreviewWatch();
  cancelWatch?.();
  cancelWatch = null;
  abortRecording();
  // 2. 通知の listener を先に外す (以後の通知で、片付けた要素を触りに行かない)
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  chrome.storage.onChanged.removeListener(onSettingsChanged);
  // 3. 監視と listener とループ
  pageObserver.disconnect();
  themeObserver.disconnect();
  playerObserver.disconnect();
  document.removeEventListener("fullscreenchange", refreshWindows);
  window.removeEventListener("resize", placeUnmovedWindows);
  stopPlayheadWatch();
  // 4. YouTube の要素の中に差したもの: プレイヤーの上の canvas (video の seeked・rVFC・ResizeObserver も) とシークバーの帯
  telopPreview.destroy();
  clearOverlay();
  // 5. ドック枠 (中の窓ごと外れる) → 拡大バーと帯の段 (rAF と捕捉) → 窓 (resize の listener)。**枠を窓より先に**:
  //    ドック中の窓は枠の根の中にあり、窓の destroy は自分の要素しか外さない
  dockManager.destroy();
  rangeBar?.destroy();
  telopTrack?.destroy();
  barWindow.destroy();
  listWindow.destroy();
  // 6. 文字起こしの取得 (走っている取得の結末は捨てる) と、写しを最初の値に戻す
  transcriptLoader?.reset();
  transcriptLoader = null;
  resetModuleState();
}

/**
 * オン / オフに合わせて start() / stop() を呼ぶ (マスタースイッチの spec §2.1)。**import 時にするのはこれだけ**:
 * chrome.storage.local を 1 回読み、onChanged を 1 本張る (どちらもページからは見えない)。オンなら読んだ後に start() が
 * 走り、オフなら何も呼ばない。
 * **このタブで録画が走っている間は stop を待つ** (canStop。spec §4.1)。待たされたら中止を送るか書き出しを待ち
 * (onStopDeferred)、終わったところ (状態の通知の末尾・中止の応答・録画の結末の送り終わり) で reconcile する
 */
const driver = createSwitchDriver({
  start,
  stop,
  canStop: () => !capturing,
  onStopDeferred,
});
