/**
 * ページ内 UI の見た目。
 *
 * YouTube の CSS 変数に寄せ、ダーク / ライトへ自動で追従させる。**すべての色に
 * フォールバック値を書くこと。** YouTube 側が変数名を変えたときに色が消えると、
 * 操作できるのに見えないという最悪の壊れ方をする。
 */

const TEXT = "var(--yt-spec-text-primary,#0f0f0f)";
const TEXT_SUB = "var(--yt-spec-text-secondary,#606060)";
const SURFACE = "var(--yt-spec-badge-chip-background,#f2f2f2)";
const ACCENT = "var(--yt-spec-call-to-action,#065fd4)";
const ON_ACCENT = "var(--yt-spec-static-brand-white,#fff)";
const FONT = 'Roboto,"Noto Sans JP","Helvetica Neue",Arial,sans-serif';

const BUTTON_BASE = `appearance:none;border-radius:18px;height:36px;padding:0 16px;font-family:${FONT};font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;`;

export const BAR_STYLE = {
  root: `display:flex;flex-direction:column;gap:10px;padding:12px 0;color:${TEXT};font-family:${FONT};font-size:13px;`,
  row: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;",
  status: `color:${TEXT_SUB};font-size:12px;`,
  /** 主操作。押してほしいものを塗りつぶす */
  primaryButton: `${BUTTON_BASE}border:none;background:${ACCENT};color:${ON_ACCENT};`,
  /** 副操作。輪郭だけ */
  secondaryButton: `${BUTTON_BASE}border:1px solid ${TEXT_SUB};background:transparent;color:${TEXT};`,
} as const;

export const RANGE_STYLE = {
  root: `display:flex;align-items:center;gap:10px;font-size:12px;color:${TEXT_SUB};font-variant-numeric:tabular-nums;`,
  track: `position:relative;flex:1;height:32px;background:${SURFACE};border-radius:6px;cursor:pointer;`,
  /** 選択範囲の外側。暗くして範囲を際立たせる */
  shade:
    "position:absolute;top:0;bottom:0;background:rgba(0,0,0,0.35);pointer-events:none;border-radius:6px;",
  selection: `position:absolute;top:0;bottom:0;background:${ACCENT};opacity:0.25;pointer-events:none;`,
  /**
   * ハンドル。見た目は細いが、透明な余白で当たり判定を広げる。
   * 掴めないと範囲を追い込めない
   */
  handle:
    "position:absolute;top:-4px;bottom:-4px;width:24px;margin-left:-12px;cursor:ew-resize;touch-action:none;background:transparent;display:flex;align-items:center;justify-content:center;",
  handleGrip: `width:6px;height:100%;border-radius:3px;background:${ACCENT};box-shadow:0 0 0 1px rgba(0,0,0,0.25);`,
  playhead: `position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:${TEXT};pointer-events:none;border-radius:1px;`,
  disabled: "opacity:0.4;pointer-events:none;",
} as const;
