/**
 * ページ内 UI の見た目。
 *
 * **YouTube の CSS 変数には頼らない。** `--yt-spec-*` は我々がバーを挿す
 * 場所 (`#below` 配下の light DOM) では 1 つも解決せず、書いたフォールバック値
 * だけが効く。実機で確認済み。そのため配色は自前で持ち、テーマは自分で判定する。
 *
 * 配色は自前の変数 (`--ytc-*`) としてバーの根に置く。テーマが切り替わったら
 * その 6 個を差し替えるだけで全体が追従する。
 */

export type Palette = {
  text: string;
  textSub: string;
  surface: string;
  border: string;
  accent: string;
  onAccent: string;
};

/** ライトテーマ。白地に置くので、面は白より確実に暗くする */
const LIGHT: Palette = {
  text: "#0f0f0f",
  textSub: "#606060",
  surface: "#e5e5e5",
  border: "#c6c6c6",
  accent: "#065fd4",
  onAccent: "#ffffff",
};

/** ダークテーマ。黒地に置くので、面は黒より確実に明るくする */
const DARK: Palette = {
  text: "#f1f1f1",
  textSub: "#aaaaaa",
  surface: "#3f3f3f",
  border: "#5a5a5a",
  accent: "#3ea6ff",
  onAccent: "#0f0f0f",
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
}

const FONT = 'Roboto,"Noto Sans JP","Helvetica Neue",Arial,sans-serif';
const BUTTON_BASE = `appearance:none;border-radius:18px;height:36px;padding:0 16px;font-family:${FONT};font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;`;

export const BAR_STYLE = {
  root: `display:flex;flex-direction:column;gap:10px;padding:12px;margin:8px 0;border:1px solid var(--ytc-border);border-radius:12px;color:var(--ytc-text);font-family:${FONT};font-size:13px;`,
  row: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;",
  status: "color:var(--ytc-text-sub);font-size:12px;",
  /** 主操作。押してほしいものを塗りつぶす */
  primaryButton: `${BUTTON_BASE}border:none;background:var(--ytc-accent);color:var(--ytc-on-accent);`,
  /** 副操作。輪郭だけ */
  secondaryButton: `${BUTTON_BASE}border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);`,
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
