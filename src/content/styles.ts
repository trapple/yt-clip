/**
 * ページ内 UI の見た目。
 *
 * **YouTube の CSS 変数には頼らない。** `--yt-spec-*` は我々がバーを挿す
 * 場所 (`#below` 配下の light DOM) では 1 つも解決せず、書いたフォールバック値
 * だけが効く。実機で確認済み。そのため配色は自前で持ち、テーマは自分で判定する。
 *
 * 配色は自前の変数 (`--ytc-*`) としてバーと窓の根に置く。テーマが
 * 切り替わったらその 7 個を差し替えるだけで全体が追従する。
 */

export type Palette = {
  text: string;
  textSub: string;
  surface: string;
  border: string;
  accent: string;
  onAccent: string;
  /**
   * 窓の地。**`surface` とは別に持つ。** `surface` はテロップ行・選択中の
   * 区間行・設定の背景に使っており、それを地にすると行と設定が地に溶ける
   */
  panel: string;
};

/** ライトテーマ。白地に置くので、面は白より確実に暗くする */
const LIGHT: Palette = {
  text: "#0f0f0f",
  textSub: "#606060",
  surface: "#e5e5e5",
  border: "#c6c6c6",
  accent: "#065fd4",
  onAccent: "#ffffff",
  panel: "#ffffff",
};

/** ダークテーマ。黒地に置くので、面は黒より確実に明るくする */
const DARK: Palette = {
  text: "#f1f1f1",
  textSub: "#aaaaaa",
  surface: "#3f3f3f",
  border: "#5a5a5a",
  accent: "#3ea6ff",
  onAccent: "#0f0f0f",
  panel: "#212121",
};

/**
 * ダークテーマかどうか。
 *
 * YouTube はダーク時に `<html dark>` を立てる。CSS 変数と違いこれは
 * 我々からも読めるので、これを第一の手がかりにする。属性が無い環境
 * (YouTube 側の変更など) では OS の設定に倒す
 */
export function isDarkTheme(root: HTMLElement = document.documentElement): boolean {
  if (root.hasAttribute("dark")) return true;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/** バーの根に配色を流し込む。テーマが変わったら呼び直す */
export function applyPalette(element: HTMLElement, dark: boolean): void {
  const palette = dark ? DARK : LIGHT;
  element.style.setProperty("--ytc-text", palette.text);
  element.style.setProperty("--ytc-text-sub", palette.textSub);
  element.style.setProperty("--ytc-surface", palette.surface);
  element.style.setProperty("--ytc-border", palette.border);
  element.style.setProperty("--ytc-accent", palette.accent);
  element.style.setProperty("--ytc-on-accent", palette.onAccent);
  element.style.setProperty("--ytc-panel", palette.panel);
}

const FONT = 'Roboto,"Noto Sans JP","Helvetica Neue",Arial,sans-serif';
const BUTTON_BASE = `appearance:none;border-radius:18px;height:36px;padding:0 16px;font-family:${FONT};font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;`;

export const BAR_STYLE = {
  /**
   * バーの中身の根 (#yt-clip-bar)。**縁・角・外の余白は持たない。** バーの窓
   * (floating-window.ts) の枠が持つ。ここにも縁を付けると枠が 2 重になる
   */
  root: `display:flex;flex-direction:column;gap:10px;padding:12px;color:var(--ytc-text);font-family:${FONT};font-size:13px;`,
  row: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;",
  /**
   * 窓を動かすつまみ (⠿)。操作の行の左端に置く (spec A.1: バーの窓は見出しの行を作らない)。
   * 行の高さはボタン (36px) に揃える。文字を選べると、掴んだつもりで選択が始まる。
   * `touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  grip: "cursor:move;user-select:none;touch-action:none;color:var(--ytc-text-sub);font-size:18px;line-height:36px;padding:0 2px;",
  /**
   * 状態の文言。**1 行に収めて、はみ出しは … にする。** 長い文言 (「テロップが N 件
   * 残っています…」など) で行が 2 段に折り返すと、バーが伸びて動画と操作が 1 画面に
   * 収まらなくなる。全文は title で出す。`min-width:0` が無いと flex の子は中身より
   * 縮まず折り返す。`flex:1` で残りの幅を取るので、後ろの ⚙ は右端に来る
   */
  status:
    "color:var(--ytc-text-sub);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  /** 主操作。押してほしいものを塗りつぶす */
  primaryButton: `${BUTTON_BASE}border:none;background:var(--ytc-accent);color:var(--ytc-on-accent);`,
  /** 副操作。輪郭だけ */
  secondaryButton: `${BUTTON_BASE}border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);`,
} as const;

export const PANEL_STYLE = {
  root: "display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--ytc-border);border-radius:8px;background:var(--ytc-surface);",
  field: "display:flex;flex-direction:column;gap:4px;",
  label: "color:var(--ytc-text);font-size:13px;font-weight:500;",
  input: `appearance:none;border:1px solid var(--ytc-border);border-radius:6px;height:36px;padding:0 10px;font-family:${FONT};font-size:14px;background:transparent;color:var(--ytc-text);`,
  hint: "color:var(--ytc-text-sub);font-size:11px;",
  footer: "display:flex;gap:8px;align-items:center;justify-content:flex-end;",
  result: "color:var(--ytc-text-sub);font-size:12px;",
} as const;

export const RANGE_STYLE = {
  root: "display:flex;align-items:center;gap:10px;font-size:12px;color:var(--ytc-text-sub);font-variant-numeric:tabular-nums;",
  track:
    "position:relative;flex:1;height:32px;background:var(--ytc-surface);border:1px solid var(--ytc-border);border-radius:6px;cursor:pointer;",
  /** 選択範囲の外側。暗くして範囲を際立たせる */
  shade:
    "position:absolute;top:0;bottom:0;background:rgba(0,0,0,0.30);pointer-events:none;",
  selection:
    "position:absolute;top:0;bottom:0;background:var(--ytc-accent);opacity:0.30;pointer-events:none;",
  /**
   * ハンドル。見た目は細いが、透明な余白で当たり判定を広げる。
   * 掴めないと範囲を追い込めない
   */
  handle:
    "position:absolute;top:-4px;bottom:-4px;width:24px;margin-left:-12px;cursor:ew-resize;touch-action:none;background:transparent;display:flex;align-items:center;justify-content:center;",
  handleGrip:
    "width:6px;height:100%;border-radius:3px;background:var(--ytc-accent);box-shadow:0 0 0 1px rgba(0,0,0,0.35);",
  playhead:
    "position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:var(--ytc-text);pointer-events:none;border-radius:1px;",
  disabled: "opacity:0.4;pointer-events:none;",
} as const;

/**
 * 拡大バーの下のテロップの帯の段 (`telop-track.ts`。フロートの窓の spec B)。
 *
 * **根は display を持たない。** 出し入れは telop-track.ts が `style.display` で行う (ここに display を
 * 書くと、`hidden` を立てても inline の display が勝って出たままになる)。高さは 2 段ぶん
 * (14 + 2 + 14 = 30px) に固定し、重なりの有無でバーの高さを揺らさない。`margin-top:-6px` で、バーの
 * 縦の並びの gap (10px) を拡大バーのトラックとの間 4px に詰める (spec B.3。予算 34px)。
 *
 * `gap`・文字の大きさ・数字の幅は拡大バー (`RANGE_STYLE.root`) に揃える。左右に置く見えない時刻
 * (`ghost`) の幅が拡大バーのラベルの幅と同じになり、帯の段がトラックの左右に揃う
 */
export const TELOP_TRACK_STYLE = {
  root: "gap:10px;height:30px;margin-top:-6px;font-size:12px;font-variant-numeric:tabular-nums;",
  ghost: "visibility:hidden;white-space:nowrap;",
  lanes: "position:relative;flex:1;min-width:0;",
  /** 右の見えない時刻の箱。「+N」をこの中の 2 段目の高さに置く (帯と重ねない。spec B.3) */
  endCell: "position:relative;",
  /**
   * 帯 1 本。位置 (left / width / top) は telop-track.ts が決める。文字を選べると、掴んだつもりで
   * 選択が始まる。`touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  band: "position:absolute;height:14px;box-sizing:border-box;min-width:4px;padding:0 4px;border:1px solid var(--ytc-accent);border-radius:3px;background:var(--ytc-surface);color:var(--ytc-text);font-size:10px;line-height:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:grab;touch-action:none;user-select:none;",
  /** 2 段に入らない分の数。押しても何もしないので、掴めそうなカーソルを出さない */
  overflow:
    "position:absolute;left:0;top:16px;height:14px;line-height:14px;font-size:11px;color:var(--ytc-text-sub);white-space:nowrap;cursor:default;",
} as const;

/** 区間の一覧。行は押せるので、押せることが分かる見た目にする */
export const SEGMENT_STYLE = {
  root: "display:flex;flex-direction:column;gap:4px;",
  row: "display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:6px;cursor:pointer;background:transparent;",
  rowSelected:
    "display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:6px;cursor:pointer;background:var(--ytc-surface);",
  label: "color:var(--ytc-text);font-size:12px;flex:1;",
  // 行のクリックと混ざらないよう、小さくても押せる大きさを確保する
  iconButton: `border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:6px;height:24px;min-width:28px;cursor:pointer;font-family:${FONT};font-size:12px;`,
  total: "color:var(--ytc-text-sub);font-size:11px;text-align:right;",
  // 超過は色だけで伝えない。文言でも「/ 60秒」と出しているので、
  // 色が見えない環境でも判断できる
  totalOver: "color:#f28b82;font-size:11px;text-align:right;font-weight:600;",
} as const;

/** テロップの一覧。区間の一覧と並ぶので見た目を揃える */
export const TELOP_STYLE = {
  root: "display:flex;flex-direction:column;gap:4px;",
  header: "display:flex;align-items:center;gap:8px;",
  title: "color:var(--ytc-text);font-size:12px;font-weight:600;flex:1;",
  row: "display:flex;flex-direction:column;gap:4px;padding:4px 8px;border-radius:6px;background:var(--ytc-surface);",
  rowHead: "display:flex;gap:8px;align-items:center;",
  label: "color:var(--ytc-text);font-size:12px;flex:1;",
  outside: "color:var(--ytc-text-sub);font-size:11px;",
  iconButton: SEGMENT_STYLE.iconButton,
  textButton: `border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:6px;height:24px;padding:0 8px;cursor:pointer;font-family:${FONT};font-size:12px;`,
  textarea: `width:100%;box-sizing:border-box;min-height:40px;resize:vertical;border:1px solid var(--ytc-border);border-radius:6px;background:transparent;color:var(--ytc-text);font-family:${FONT};font-size:13px;padding:4px 6px;`,
} as const;

/**
 * 見出しのある「幅と高さ」の窓 (`panel-window.ts`。区間・テロップの窓と設定の窓) の中身の箱。
 * **枠の見た目 (地・影・見出し) は `FLOATING_WINDOW_STYLE` が持つ。** 位置・幅は YouTube の実機の値に
 * 合わせるので、出所と一緒に `panel-window.ts` が持つ。
 *
 * **`body` は display を持つ (flex)。** 右側のパネルの本体が display を持たなかったのは、折り畳みで
 * 本体を出し入れしていたため。折り畳みをやめた (窓の分割の spec C1.2) ので、本体を出し入れする者はいない
 * (窓ごとの出し入れは `floating-window.ts` が窓の根の style.display で行う)
 */
export const PANEL_WINDOW_STYLE = {
  /**
   * 中身の箱。**超えた分はここだけでスクロールする。** `min-height:0` が無いと
   * flex の子は中身より縮まず、窓ごと画面の下へ伸びる
   */
  body: "display:flex;flex-direction:column;gap:12px;padding:0 12px 12px;overflow-y:auto;min-height:0;flex:1 1 auto;",
} as const;

/**
 * フロートの窓の枠 (`floating-window.ts`)。バーの窓・区間・テロップの窓・設定の窓で同じものを使う。
 *
 * **`root`・`docked`・`resizeGrip` は display を持たない。** 出し入れは `floating-window.ts` が
 * `style.display` で行う。ここに display を書くと、`hidden` を立てても inline の display が
 * 勝って出たままになる。位置・大きさ・重なり順も `floating-window.ts` が決める
 */
export const FLOATING_WINDOW_STYLE = {
  /** 下のページが透けると読めないので、不透明な地と影を付ける */
  root: `position:fixed;flex-direction:column;box-sizing:border-box;overflow:hidden;background:var(--ytc-panel);color:var(--ytc-text);border:1px solid var(--ytc-border);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:${FONT};font-size:13px;`,
  /**
   * ページの中の枠に入っている間 (窓の分割の spec C2.8)。**ページの流れの中** (static) で枠の幅いっぱい。
   * ページに埋まるので影は付けず、角丸は枠に合わせて小さくする。z-index は効かないので auto
   */
  docked: `position:static;flex-direction:column;box-sizing:border-box;width:100%;overflow:hidden;background:var(--ytc-panel);color:var(--ytc-text);border:1px solid var(--ytc-border);border-radius:8px;box-shadow:none;z-index:auto;font-family:${FONT};font-size:13px;`,
  /**
   * 見出し。空いたところを掴んで動かす。文字を選べると、掴んだつもりで選択が始まる。
   * `touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  header:
    "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;user-select:none;touch-action:none;",
  title: "flex:1;color:var(--ytc-text);font-size:13px;font-weight:600;",
  /**
   * 右下の角のつまみ (16px 四方。spec A.1)。カーソルは窓の向き (幅だけ / 幅と高さ) で
   * `floating-window.ts` が足す
   */
  resizeGrip:
    "position:absolute;right:0;bottom:0;width:16px;height:16px;touch-action:none;background:linear-gradient(135deg,transparent 50%,var(--ytc-border) 50%);",
} as const;
