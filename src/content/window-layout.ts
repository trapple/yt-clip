/**
 * フロートの窓 (バーの窓・区間・テロップの窓・設定の窓) の位置と大きさ
 * (`.claude/specs/2026-09-24-floating-windows-design.md` A.2 / A.3、
 * `.claude/specs/2026-09-25-dockable-windows-design.md` C1.3)。
 *
 * 覚えた配置の保存・読み込み・検証と、画面に詰める計算を持つ。計算は純粋関数にして、
 * DOM を持たないテストで確かめる。
 *
 * **`chrome.storage.local` に置く (sync にしない)。** 画面の大きさと窓の置き場所の好みは
 * 端末ごとに違う。sync で運ぶと、大きい画面で置いた位置が小さい画面の端末へ届く
 */

export const WINDOW_LAYOUT_KEY = "windowLayout";

/** 窓の名前 (窓の分割の spec C1.1)。覚えた配置の鍵にも使う */
export type WindowId = "bar" | "list" | "settings";
const WINDOW_IDS: readonly WindowId[] = ["bar", "list", "settings"];
/** ドック枠の名前 (C2)。C1 では型だけを置き、枠の中身は常に空 */
export type DockSlotId = "below" | "side";
const DOCK_SLOT_IDS: readonly DockSlotId[] = ["below", "side"];
/** 枠に入っている窓 (タブの並び。前から) と、前に出しているタブ (C2) */
export type DockState = { tabs: WindowId[]; active?: WindowId };

/** 画面 (viewport) の座標で、窓の左上と大きさ。height が無い窓は高さを中身に任せる */
export type WindowRect = { left: number; top: number; width: number; height?: number };
/** 覚えている配置の形の版。古い形 (v1: `{ bar?, panel? }`) は version を持たない */
export const WINDOW_LAYOUT_VERSION = 2;
/**
 * 覚える配置 (C1.3)。**C2 の枠の情報も入る形にしておく** (C1 と C2 で読み替えを 2 回書かない)
 */
export type WindowLayout = {
  version: 2;
  /** フロートで置いた位置と大きさ。無い窓は最初の位置 (A.2 / C1.3) */
  float: Partial<Record<WindowId, WindowRect>>;
  /** 枠ごとの、入っている窓 (タブの並び。前から) と前に出しているタブ。C1 では常に空 */
  docks: Partial<Record<DockSlotId, DockState>>;
};
export type Viewport = { width: number; height: number };
/** 掴む場所 (区間・テロップの窓と設定の窓は見出し、バーはつまみ) の箱。窓の左上からの位置 */
export type GripBox = { left: number; top: number; width: number; height: number };
export type SizeLimits = { minWidth: number; minHeight?: number };

/** 何も覚えていないときの配置 (3 つとも最初の位置)。呼ぶたびに新しい組を返す (書き換えても共有しない) */
export function emptyWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: {}, docks: {} };
}

/*
 * YouTube のヘッダーの寸法。**実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020。YouTube のレイアウトが
 * 変わったら測り直す。
 *
 * **ここに置く (panel-window.ts ではなく)。** 区間・テロップの窓の最初の上端 (panel-window.ts) とバーの窓の
 * 上端の下限 (initialBarRect) の 2 箇所が使う。panel-window.ts は floating-window.ts を経て
 * このファイルを読むので、逆向きに読むと循環する
 */
/** YouTube のヘッダー (#masthead-container) の高さ */
export const MASTHEAD_HEIGHT_PX = 56;
/** ヘッダーとの間 */
export const TOP_GAP_PX = 12;

/** バーの窓の最初の位置: プレイヤーの下端との間 (spec A.2) */
export const BAR_GAP_PX = 8;
/** 画面の下端との間。画面に収まらないバーの窓はここまで詰める (spec A.2) */
export const SCREEN_BOTTOM_GAP_PX = 16;
/**
 * どんな画面よりも大きい値。壊れた値 (1e9 など) を弾くためだけの上限。
 * 画面より大きいだけの値は弾かない (fitRect が詰める。大きい画面で覚えた位置を
 * 小さい画面で開いたとき)
 */
const MAX_COORD_PX = 100_000;

function isCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORD_PX;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COORD_PX;
}

/** 高さが無い窓は、高さのキーごと持たない (保存にも undefined を書かない) */
function toRect(left: number, top: number, width: number, height: number | undefined): WindowRect {
  return height === undefined ? { left, top, width } : { left, top, width, height };
}

function parseRect(value: unknown): WindowRect | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!isCoord(source.left) || !isCoord(source.top) || !isSize(source.width)) return null;
  if (source.height !== undefined && !isSize(source.height)) return null;
  return toRect(source.left, source.top, source.width, source.height);
}

/** 組 (配列でない object) か。配列も typeof は "object" なので分ける */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 覚えた位置を窓ごとに読む。keys は「保存されている鍵 → 窓の名前」。型と範囲が合わない窓は
 * 捨てて warn する (ほかの窓は使う)。知らない鍵は黙って無視する (後の版で窓が増えても古い版が騒がない)
 */
function readRects(
  source: Record<string, unknown>,
  keys: readonly (readonly [string, WindowId])[],
  path: string,
): Partial<Record<WindowId, WindowRect>> {
  const rects: Partial<Record<WindowId, WindowRect>> = {};
  for (const [key, id] of keys) {
    const value = source[key];
    if (value === undefined) continue;
    const rect = parseRect(value);
    if (rect === null) {
      console.warn(
        `[yt-clip] 保存された windowLayout.${path}${key} が使えないため最初の位置を使います: ${JSON.stringify(value)}`,
      );
      continue;
    }
    rects[id] = rect;
  }
  return rects;
}

/** 古い形 (v1) の鍵 → 窓。パネルの位置は区間・テロップの窓が継ぐ。設定の窓は v1 に無い (C1.3) */
const V1_KEYS = [
  ["bar", "bar"],
  ["panel", "list"],
] as const;
const V2_KEYS = WINDOW_IDS.map((id) => [id, id] as const);

/**
 * 覚えた配置を読む (C1.3)。**型は保証されない** (古い版が書いたもの・手で書き換えたもの)。
 *
 * - `version` のキーが無ければ古い形 (v1: `{ bar?, panel? }`)。`bar` → `float.bar`、`panel` → `float.list`
 *   に読み替える。**読み替えた組は書き戻さない** (読み込みは書かない。次に動かしたときに v2 で書く)
 * - `version` が 2 なら v2。`float` と `docks` が組でなければ、組ごと捨てて warn する
 * - それ以外の `version` (後の版が書いた 3 など) は形が分からないので、推測で読まずに warn して最初の配置
 *
 * 窓ごとに型と範囲を確かめ、合わない窓は捨てて最初の位置に戻す。握りつぶさず理由は残す
 * (設定の mergeSettings と同じ作法)。**`docks` の中身はまだ読まない** (枠に入れる経路がまだ無い。
 * タブの並びの検証はドック枠を入れるときに足す)
 */
export function mergeWindowLayout(stored: unknown): WindowLayout {
  if (stored === undefined) return emptyWindowLayout();
  if (!isRecord(stored)) {
    console.warn(
      `[yt-clip] 保存された windowLayout が使えないため最初の位置を使います: ${JSON.stringify(stored)}`,
    );
    return emptyWindowLayout();
  }
  if (!("version" in stored)) {
    return { ...emptyWindowLayout(), float: readRects(stored, V1_KEYS, "") };
  }
  if (stored.version !== WINDOW_LAYOUT_VERSION) {
    console.warn(
      `[yt-clip] 保存された windowLayout の版 (${JSON.stringify(stored.version)}) を読めないため最初の位置を使います`,
    );
    return emptyWindowLayout();
  }
  if (!isRecord(stored.float) || !isRecord(stored.docks)) {
    console.warn(
      `[yt-clip] 保存された windowLayout の float / docks が使えないため最初の位置を使います: ${JSON.stringify(stored)}`,
    );
    return emptyWindowLayout();
  }
  return { ...emptyWindowLayout(), float: readRects(stored.float, V2_KEYS, "float.") };
}

/**
 * value を min〜max に収める。**範囲が逆転する (画面が掴む場所より小さい) ときは min を採る。**
 * 掴む場所の左上を画面に残す方を選ぶ
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 窓の位置と大きさを画面に詰める (spec A.1)。
 *
 * - 大きさは最小〜画面の大きさ。画面が最小より狭いときは最小を採る
 * - 位置は**掴む場所の全体が画面に残る**ところまで詰める。上は画面の上端ではなく YouTube の
 *   ヘッダー (MASTHEAD_HEIGHT_PX) の下まで。窓の残りは画面の外へ出てよい
 *   (バーの窓はつまみが左端にあるので、右へ寄せると窓の大半が画面の外へ出る)。
 *   窓全体を画面に入れる案は採らない: 幅いっぱいのバーの窓が一切動かせなくなる
 */
export function fitRect(
  rect: WindowRect,
  viewport: Viewport,
  grip: GripBox,
  limits: SizeLimits,
): WindowRect {
  const width = clamp(rect.width, limits.minWidth, viewport.width);
  const minHeight = limits.minHeight ?? 0;
  const height =
    rect.height === undefined ? undefined : clamp(rect.height, minHeight, viewport.height);
  // 窓からはみ出す分の掴む場所は数えない。大きさを変えている最中は、見出しが 1 つ前の
  // 広い幅で測られる
  const gripWidth = Math.max(0, Math.min(grip.width, width - grip.left));
  const gripHeight =
    height === undefined ? grip.height : Math.max(0, Math.min(grip.height, height - grip.top));
  // 下限は `0 - grip.left` と書く。`-grip.left` だと grip.left が 0 のとき -0 になり、
  // テストの toEqual (Object.is で比べる) が 0 と区別して落ちる
  const left = clamp(rect.left, 0 - grip.left, viewport.width - grip.left - gripWidth);
  // 上は画面の上端ではなく YouTube のヘッダーの下まで。ヘッダーは窓より上 (z-index 2020) に
  // 出るので、掴む場所がヘッダーの裏に入ると押せず、窓を動かせなくなる
  const top = clamp(rect.top, MASTHEAD_HEIGHT_PX - grip.top, viewport.height - grip.top - gripHeight);
  return toRect(left, top, width, height);
}

/**
 * バーの窓の最初の位置 (spec A.2)。プレイヤーの直下に、左端を揃えてプレイヤーの幅で置く。
 * 画面に収まらなければ画面の下端から SCREEN_BOTTOM_GAP_PX に詰める (このときだけプレイヤーに
 * 重なりうる)。**上端はヘッダーの下 (MASTHEAD_HEIGHT_PX + TOP_GAP_PX、区間・テロップの窓の最初の上端と
 * 同じ) より上へ出さない。** 窓 (z-index 2000) はヘッダー (z-index 2020) より下なので、上端 0 に
 * 置くと拡大バーがヘッダーの裏に隠れる。プレイヤーが画面の上へスクロールされて消えている間に
 * 取り直したとき (ブラウザの大きさを変えたなど) に起きる。
 *
 * player は**画面上の位置** (getBoundingClientRect)。ページがスクロールされていても、そのまま使う
 */
export function initialBarRect(
  player: { left: number; bottom: number; width: number },
  barHeight: number,
  viewport: Viewport,
): WindowRect {
  const below = player.bottom + BAR_GAP_PX;
  const lowest = viewport.height - SCREEN_BOTTOM_GAP_PX - barHeight;
  const highest = MASTHEAD_HEIGHT_PX + TOP_GAP_PX;
  return { left: player.left, top: Math.max(highest, Math.min(below, lowest)), width: player.width };
}

/**
 * 保存を 1 本の列にする。**書き込みの順を保つ** (先に呼んだ保存が後に呼んだ保存より後に届き、
 * 新しい配置を古い配置で上書きしないように)。組ごと書くようになって「読んで書き戻す処理が重なり、
 * 先の書き込みが後の書き込みで消える」ことは無くなったが、書き込みが呼んだ順に済む保証は無いので残す
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // 1 つが失敗しても後ろの保存は続ける。失敗は呼び出し側 (run) に返す
  queue = run.catch(() => undefined);
  return run;
}

/** 保存する形に写す。高さが無い窓は高さのキーごと持たない (保存に undefined を書かない) */
function toStored(layout: WindowLayout): WindowLayout {
  const float: Partial<Record<WindowId, WindowRect>> = {};
  for (const id of WINDOW_IDS) {
    const rect = layout.float[id];
    if (rect !== undefined) float[id] = toRect(rect.left, rect.top, rect.width, rect.height);
  }
  const docks: Partial<Record<DockSlotId, DockState>> = {};
  for (const slot of DOCK_SLOT_IDS) {
    const dock = layout.docks[slot];
    if (dock === undefined) continue;
    docks[slot] =
      dock.active === undefined
        ? { tabs: [...dock.tabs] }
        : { tabs: [...dock.tabs], active: dock.active };
  }
  return { version: WINDOW_LAYOUT_VERSION, float, docks };
}

/**
 * 覚えた配置を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残して空の組を返し、窓は
 * 最初の位置で出る (spec A.2「読み込みが失敗 (reject) したら console.warn を残して最初の位置で
 * 出す」)。投げると、呼び出し側が窓を出さないままにする経路を作りうる
 */
export async function loadWindowLayout(): Promise<WindowLayout> {
  try {
    const stored = await chrome.storage.local.get(WINDOW_LAYOUT_KEY);
    return mergeWindowLayout(stored[WINDOW_LAYOUT_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] 窓の位置を読めないため最初の位置を使います: ${String(error)}`);
    return emptyWindowLayout();
  }
}

/**
 * 窓の配置を組ごと覚える (C1.3)。**前に覚えていた組は読まない** (読んで書き戻さない)。組は
 * youtube.ts が持つ写しから毎回作る: ドック枠を入れると、1 つの窓の操作で 2 つの枠のタブの並びが
 * 変わりうり (引き出して別の枠へ)、窓ごとの部分更新では整合が取れない。
 * **呼んだ時点の組を写してから列に並べる** (並んでいる間に呼び出し側が写しを書き換えても、
 * この呼び出しの組を書く。後の組は後の呼び出しが書く)
 */
export function saveWindowLayout(layout: WindowLayout): Promise<void> {
  const value = toStored(layout);
  return serialize(async () => {
    await chrome.storage.local.set({ [WINDOW_LAYOUT_KEY]: value });
  });
}
