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
export const WINDOW_IDS: readonly WindowId[] = ["bar", "list", "settings"];
/**
 * ドック枠の名前 (C2.1)。below はプレイヤーの下 (#below の先頭)、side は右の列 (#secondary-inner の先頭。
 * おすすめ動画の上)
 */
export type DockSlotId = "below" | "side";
export const DOCK_SLOT_IDS: readonly DockSlotId[] = ["below", "side"];
/** 1 つの枠に入っている窓 (タブの並び。前から = 入れた順) と、前に出しているタブ (C2.2) */
export type DockTabs = { tabs: WindowId[]; active?: WindowId };
/**
 * 枠ごとの中身 (C2.6)。窓が 1 つも無い枠は鍵ごと持たない。**型はここに置く** (保存データの検証が使う。
 * dock.ts に置くと dock.ts → floating-window.ts → このファイルと循環する)。dock.ts は見せ直すだけ
 */
export type DockState = Partial<Record<DockSlotId, DockTabs>>;

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
  /**
   * 枠ごとの、入っている窓 (タブの並び。前から) と前に出しているタブ (C2.6)。**float と両方にある窓は枠に入っている**
   * (float の値は引き出したときの大きさにだけ使う。C2.1 / C2.4)
   */
  docks: DockState;
};
export type Viewport = { width: number; height: number };
/** 掴む場所 (区間・テロップの窓と設定の窓は見出し、バーはつまみ) の箱。窓の左上からの位置 */
export type GripBox = { left: number; top: number; width: number; height: number };
export type SizeLimits = { minWidth: number; minHeight?: number };

/**
 * 最初の配置 (C2.6): **ドック**。バーは下の枠、区間・テロップの窓と設定の窓は右の枠 (並びは区間・テロップ → 設定)。
 * 設定のタブは ⚙ で開いている間、区間・テロップのタブはエディットモードで区間がある間だけ出る (隠れた窓のタブは出さない)。
 * ユーザーが 2026-09-25 に選んだ。**最初の配置はここ 1 か所に置く**: initialWindowLayout (何も覚えていない・壊れた値・
 * 読めない版)、v1 の読み替え (位置の無い窓)、ダブルクリックの戻し先 (dock.ts の restore に youtube.ts が渡す) がここを見る
 */
const INITIAL_DOCKS: DockState = {
  below: { tabs: ["bar"] },
  side: { tabs: ["list", "settings"] },
};

/** 枠の中身を写す (呼び出し側が書き換えても共有しない) */
function cloneDocks(docks: DockState): DockState {
  const copy: DockState = {};
  for (const slot of DOCK_SLOT_IDS) {
    const entry = docks[slot];
    if (entry === undefined) continue;
    copy[slot] =
      entry.active === undefined
        ? { tabs: [...entry.tabs] }
        : { tabs: [...entry.tabs], active: entry.active };
  }
  return copy;
}

/** 最初の配置の枠の写し */
export function initialDocks(): DockState {
  return cloneDocks(INITIAL_DOCKS);
}

/**
 * 最初の配置の枠から、ids の窓を除いたもの (v1 で位置を覚えていた窓は浮いた窓のまま読む。C2.6)。
 * 窓が残らない枠は鍵ごと持たない
 */
function initialDocksWithout(ids: readonly WindowId[]): DockState {
  const docks: DockState = {};
  for (const slot of DOCK_SLOT_IDS) {
    const tabs = INITIAL_DOCKS[slot]?.tabs.filter((id) => !ids.includes(id)) ?? [];
    if (tabs.length > 0) docks[slot] = { tabs };
  }
  return docks;
}

/**
 * 最初の配置の組 (浮いた窓の位置は無く、枠は INITIAL_DOCKS)。呼ぶたびに新しい組を返す (書き換えても共有しない)
 */
export function initialWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: {}, docks: initialDocks() };
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

function isWindowId(value: unknown): value is WindowId {
  return typeof value === "string" && (WINDOW_IDS as readonly string[]).includes(value);
}

/**
 * その窓をその枠に入れられるか (C2.5)。**バーは右の枠に入れない**: バーの最小の幅 480px (フロートの窓の spec A.1。
 * 拡大バーの精度) が右の列の幅 (1920x1080 で 544px、1440x795 で 400px 前後) より広く、入れると最小の幅より
 * 狭くなるか列からはみ出す
 */
export function acceptsDock(id: WindowId, slot: DockSlotId): boolean {
  return !(id === "bar" && slot === "side");
}

/**
 * 覚えた枠の中身を読む (C2.6)。**型は保証されない。** 使えないものは捨てて warn する (ほかは使う):
 *
 * - 組でない → どの枠も空
 * - 枠ごと: 組でない・`tabs` が配列でない → その枠を捨てる
 * - `tabs` の窓: 知らない名前・既に入っている窓 (同じ枠の重複は先頭、別の枠との重複は below → side の先を残す。
 *   窓は 1 つの枠にしか入らない)・入れられない組み合わせ (右の枠のバー。acceptsDock) を捨てる。残りが無い枠は鍵ごと持たない
 * - `active` が `tabs` に無ければ無い扱い (前のタブは見えているタブの先頭になる)
 *
 * 無いだけ (undefined) なら空として読み、warn しない。知らない枠の名前は黙って無視する (後の版で枠が増えても
 * 古い版が騒がない。float の知らない窓と同じ)
 */
export function parseDockState(value: unknown): DockState {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    console.warn(
      `[yt-clip] 保存された windowLayout.docks が使えないため、どの窓も枠に入れません: ${JSON.stringify(value)}`,
    );
    return {};
  }
  const docks: DockState = {};
  /** 既にどこかの枠に入れた窓。窓は 1 つの枠にしか入らない */
  const seen = new Set<WindowId>();
  for (const slot of DOCK_SLOT_IDS) {
    const entry = value[slot];
    if (entry === undefined) continue;
    const rawTabs: unknown = isRecord(entry) ? entry.tabs : undefined;
    if (!isRecord(entry) || !Array.isArray(rawTabs)) {
      console.warn(
        `[yt-clip] 保存された windowLayout.docks.${slot} が使えないため捨てます: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    const tabs: WindowId[] = [];
    for (const tab of rawTabs as unknown[]) {
      if (!isWindowId(tab) || seen.has(tab) || !acceptsDock(tab, slot)) {
        console.warn(
          `[yt-clip] 保存された windowLayout.docks.${slot}.tabs の ${JSON.stringify(tab)} を捨てます (知らない窓・重複・入れられない枠)`,
        );
        continue;
      }
      seen.add(tab);
      tabs.push(tab);
    }
    if (tabs.length === 0) continue;
    const active = entry.active;
    if (active === undefined) {
      docks[slot] = { tabs };
    } else if (isWindowId(active) && tabs.includes(active)) {
      docks[slot] = { tabs, active };
    } else {
      console.warn(
        `[yt-clip] 保存された windowLayout.docks.${slot}.active (${JSON.stringify(active)}) が tabs に無いため捨てます`,
      );
      docks[slot] = { tabs };
    }
  }
  return docks;
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
 * 覚えた配置を読む (C1.3 / C2.6)。**型は保証されない** (古い版が書いたもの・手で書き換えたもの)。
 *
 * - 何も覚えていない・組でない → 最初の配置 (ドック。INITIAL_DOCKS)
 * - `version` のキーが無ければ古い形 (v1: `{ bar?, panel? }`)。`bar` → `float.bar`、`panel` → `float.list`
 *   に読み替える。**位置を覚えていた窓は浮いた窓のまま**、位置の無い窓 (`settings` を含む) は最初の配置の枠に入れる
 *   (A で自分で動かした窓を黙ってドックへ移さない)。**読み替えた組は書き戻さない** (読み込みは書かない。
 *   次に動かしたときに v2 で書く)
 * - `version` が 2 なら v2 を書いてあるとおりに読む (`docks: {}` なら 3 つとも浮いた窓)。`float` と `docks` は**無いだけなら空**
 *   として読む (正しい float まで捨てない)。組でなければ、その部分だけ捨てて warn する。枠の中身は parseDockState が確かめる
 * - それ以外の `version` (後の版が書いた 3 など) は形が分からないので、推測で読まずに warn して最初の配置
 *
 * 窓ごとに型と範囲を確かめ、合わない窓は捨てて warn する。握りつぶさず理由は残す (設定の mergeSettings と同じ作法)。
 * **同じ窓が float と docks の両方にあれば枠に入る** (float の値は引き出したときの大きさにだけ使うので捨てない。C2.1 / C2.6)
 */
export function mergeWindowLayout(stored: unknown): WindowLayout {
  if (stored === undefined) return initialWindowLayout();
  if (!isRecord(stored)) {
    console.warn(
      `[yt-clip] 保存された windowLayout が使えないため最初の配置を使います: ${JSON.stringify(stored)}`,
    );
    return initialWindowLayout();
  }
  if (!("version" in stored)) {
    const float = readRects(stored, V1_KEYS, "");
    const placed = WINDOW_IDS.filter((id) => float[id] !== undefined);
    return { version: WINDOW_LAYOUT_VERSION, float, docks: initialDocksWithout(placed) };
  }
  if (stored.version !== WINDOW_LAYOUT_VERSION) {
    console.warn(
      `[yt-clip] 保存された windowLayout の版 (${JSON.stringify(stored.version)}) を読めないため最初の配置を使います`,
    );
    return initialWindowLayout();
  }
  const float: unknown = stored.float === undefined ? {} : stored.float;
  if (!isRecord(float)) {
    console.warn(
      `[yt-clip] 保存された windowLayout.float が使えないため、浮いた窓を最初の位置に置きます: ${JSON.stringify(float)}`,
    );
  }
  return {
    version: WINDOW_LAYOUT_VERSION,
    float: isRecord(float) ? readRects(float, V2_KEYS, "float.") : {},
    docks: parseDockState(stored.docks),
  };
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
  return { version: WINDOW_LAYOUT_VERSION, float, docks: cloneDocks(layout.docks) };
}

/**
 * 覚えた配置を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残して最初の配置の組を返し、窓は
 * 最初の配置で出る (spec A.2「読み込みが失敗 (reject) したら console.warn を残して最初の位置で
 * 出す」)。投げると、呼び出し側が窓を出さないままにする経路を作りうる
 */
export async function loadWindowLayout(): Promise<WindowLayout> {
  try {
    const stored = await chrome.storage.local.get(WINDOW_LAYOUT_KEY);
    return mergeWindowLayout(stored[WINDOW_LAYOUT_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] 窓の配置を読めないため最初の配置を使います: ${String(error)}`);
    return initialWindowLayout();
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
