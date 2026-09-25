/**
 * フロートの窓 (バーの窓・パネルの窓) の位置と大きさ
 * (`.claude/specs/2026-09-24-floating-windows-design.md` A.2 / A.3)。
 *
 * 覚えた位置の保存・読み込み・検証と、画面に詰める計算を持つ。計算は純粋関数にして、
 * DOM を持たないテストで確かめる。
 *
 * **`chrome.storage.local` に置く (sync にしない)。** 画面の大きさと窓の置き場所の好みは
 * 端末ごとに違う。sync で運ぶと、大きい画面で置いた位置が小さい画面の端末へ届く
 */

export const WINDOW_LAYOUT_KEY = "windowLayout";

export type WindowId = "bar" | "panel";
const WINDOW_IDS: readonly WindowId[] = ["bar", "panel"];

/** 画面 (viewport) の座標で、窓の左上と大きさ。height が無い窓は高さを中身に任せる */
export type WindowRect = { left: number; top: number; width: number; height?: number };
export type WindowLayout = Partial<Record<WindowId, WindowRect>>;
export type Viewport = { width: number; height: number };
/** 掴む場所 (パネルは見出し、バーはつまみ) の箱。窓の左上からの位置 */
export type GripBox = { left: number; top: number; width: number; height: number };
export type SizeLimits = { minWidth: number; minHeight?: number };

/*
 * YouTube のヘッダーの寸法。**実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020。YouTube のレイアウトが
 * 変わったら測り直す。
 *
 * **ここに置く (side-panel.ts ではなく)。** パネルの窓の最初の上端 (side-panel.ts) とバーの窓の
 * 上端の下限 (initialBarRect) の 2 箇所が使う。side-panel.ts は floating-window.ts を経て
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

/**
 * 覚えた位置を読む。**型は保証されない** (古い版が書いたもの・手で書き換えたもの)。
 * 窓ごとに型と範囲を確かめ、合わない窓は捨てて最初の位置に戻す。握りつぶさず理由は残す
 * (設定の mergeSettings と同じ作法)
 */
export function mergeWindowLayout(stored: unknown): WindowLayout {
  if (stored === undefined) return {};
  if (stored === null || typeof stored !== "object") {
    console.warn(
      `[yt-clip] 保存された windowLayout が使えないため最初の位置を使います: ${String(stored)}`,
    );
    return {};
  }
  const source = stored as Record<string, unknown>;
  const layout: WindowLayout = {};
  for (const id of WINDOW_IDS) {
    const value = source[id];
    if (value === undefined) continue;
    const rect = parseRect(value);
    if (rect === null) {
      console.warn(
        `[yt-clip] 保存された windowLayout.${id} が使えないため最初の位置を使います: ${JSON.stringify(value)}`,
      );
      continue;
    }
    layout[id] = rect;
  }
  return layout;
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
 * - 位置は**掴む場所の全体が画面に残る**ところまで詰める。窓の残りは画面の外へ出てよい
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
  const top = clamp(rect.top, 0 - grip.top, viewport.height - grip.top - gripHeight);
  return toRect(left, top, width, height);
}

/**
 * バーの窓の最初の位置 (spec A.2)。プレイヤーの直下に、左端を揃えてプレイヤーの幅で置く。
 * 画面に収まらなければ画面の下端から SCREEN_BOTTOM_GAP_PX に詰める (このときだけプレイヤーに
 * 重なりうる)。**上端はヘッダーの下 (MASTHEAD_HEIGHT_PX + TOP_GAP_PX、パネルの窓の最初の上端と
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
 * 保存を 1 本の列にする。**2 つの窓をすぐ続けて動かすと、読んで書き戻す処理が重なり、
 * 先の書き込みが後の書き込みで消える** (どちらも古い値を読んでから書くため)
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // 1 つが失敗しても後ろの保存は続ける。失敗は呼び出し側 (run) に返す
  queue = run.catch(() => undefined);
  return run;
}

/** 保存されている組をそのまま読む (書き戻す用)。検証しないのは、使えない窓も消さずに残すため */
async function readStored(): Promise<Record<string, unknown>> {
  const stored = (await chrome.storage.local.get(WINDOW_LAYOUT_KEY))[WINDOW_LAYOUT_KEY];
  return stored !== null && typeof stored === "object"
    ? { ...(stored as Record<string, unknown>) }
    : {};
}

/**
 * 覚えた位置を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残して空を返し、2 つの窓は
 * 最初の位置で出る (spec A.2「読み込みが失敗 (reject) したら console.warn を残して最初の位置で
 * 出す」)。投げると、呼び出し側が窓を出さないままにする経路を作りうる
 */
export async function loadWindowLayout(): Promise<WindowLayout> {
  try {
    const stored = await chrome.storage.local.get(WINDOW_LAYOUT_KEY);
    return mergeWindowLayout(stored[WINDOW_LAYOUT_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] 窓の位置を読めないため最初の位置を使います: ${String(error)}`);
    return {};
  }
}

/** 1 つの窓の位置と大きさを覚える。もう片方の窓は残す */
export function saveWindowRect(id: WindowId, rect: WindowRect): Promise<void> {
  return serialize(async () => {
    const current = await readStored();
    current[id] = toRect(rect.left, rect.top, rect.width, rect.height);
    await chrome.storage.local.set({ [WINDOW_LAYOUT_KEY]: current });
  });
}

/** 1 つの窓の覚えた位置を消す (掴む場所のダブルクリックで最初の位置に戻したとき) */
export function clearWindowRect(id: WindowId): Promise<void> {
  return serialize(async () => {
    const current = await readStored();
    delete current[id];
    await chrome.storage.local.set({ [WINDOW_LAYOUT_KEY]: current });
  });
}
