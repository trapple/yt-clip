import { SIDE_PANEL_STYLE } from "@/content/styles";

/**
 * 画面右側に固定するパネル。区間の一覧・テロップの一覧・設定を入れる
 * (`.claude/specs/2026-09-24-side-panel-design.md`)。
 *
 * **枠 (見出し・折り畳み・中身の箱) だけを持つ。** 何を入れるか、いつ出すかは知らない。
 * 出すかの理由 (中身が無い / 全画面 / 動画ページ以外) は youtube.ts の 1 箇所で決める。
 * ここにも理由を持たせると、2 箇所の判定が食い違ったときにどちらが正か分からなくなる
 */

export const SIDE_PANEL_ID = "yt-clip-panel";
export const SIDE_PANEL_BODY_ID = `${SIDE_PANEL_ID}-body`;

/*
 * 位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020、
 * #secondary の幅 544px、ytd-popup-container の z-index auto。
 * YouTube のレイアウトが変わったら測り直す
 */
/** YouTube のヘッダー (#masthead-container) の高さ */
const MASTHEAD_HEIGHT_PX = 56;
/** ヘッダーとの間 */
const TOP_GAP_PX = 12;
/** 画面の右端・下端との間 */
const EDGE_GAP_PX = 16;
/** おすすめ動画の列 (#secondary、402px 前後) の上に収まる幅 */
const WIDTH_PX = 400;
/** YouTube のヘッダーのメニュー類より下、ページ本体より上 */
const Z_INDEX = 2000;

export type SidePanel = {
  element: HTMLElement;
  /** 中身の箱。区間の一覧・テロップの一覧・設定パネルをこの順に入れる */
  body: HTMLElement;
  /**
   * 出すか隠すか。**理由の計算は youtube.ts の 1 箇所に置く** (中身が無い / 全画面 / 動画ページ以外、の
   * どれかなら隠す)。パネルは理由を知らない
   */
  setVisible(visible: boolean): void;
  /** 畳んでいれば開く (設定を開いた・区間やテロップを足したとき) */
  reveal(): void;
  /** 本体の中だけをスクロールして、target の先頭を見える範囲に入れる */
  scrollTo(target: HTMLElement): void;
  destroy(): void;
};

export function createSidePanel(): SidePanel {
  const top = MASTHEAD_HEIGHT_PX + TOP_GAP_PX;
  const element = document.createElement("div");
  element.id = SIDE_PANEL_ID;
  // 高さは中身に合わせ、最大で画面の下端から EDGE_GAP_PX まで。超えた分は本体だけが
  // スクロールする (body の overflow-y)
  element.style.cssText = `${SIDE_PANEL_STYLE.root}position:fixed;top:${top}px;right:${EDGE_GAP_PX}px;width:${WIDTH_PX}px;max-height:calc(100vh - ${top + EDGE_GAP_PX}px);z-index:${Z_INDEX};`;

  const header = document.createElement("div");
  header.style.cssText = SIDE_PANEL_STYLE.header;
  const title = document.createElement("span");
  title.style.cssText = SIDE_PANEL_STYLE.title;
  title.textContent = "yt-clip";
  const collapseButton = document.createElement("button");
  collapseButton.dataset.role = "collapse";
  collapseButton.style.cssText = SIDE_PANEL_STYLE.collapseButton;
  header.append(title, collapseButton);

  const body = document.createElement("div");
  body.id = SIDE_PANEL_BODY_ID;
  body.style.cssText = SIDE_PANEL_STYLE.body;

  element.append(header, body);

  /**
   * 畳んでいるか。**タブを開いている間だけ覚える** (保存しない)。保存すると
   * 「パネルが出ない」という相談の原因になりやすく、得るものが小さい
   */
  let collapsed = false;

  /**
   * 出し入れは `hidden` と `style.display` の両方で行う。**`hidden` だけに頼らない。**
   * 根と本体は flex で並べるので display を持つ。inline の display は UA の
   * `[hidden] { display: none }` に勝ち、`hidden` を立てても出たままになる。
   * `hidden` は外から「出ているか / 畳んでいるか」を読むために残す
   */
  function show(target: HTMLElement, visible: boolean): void {
    target.hidden = !visible;
    target.style.display = visible ? "flex" : "none";
  }

  function setCollapsed(next: boolean): void {
    collapsed = next;
    show(body, !next);
    // 畳むと右へ引っ込む向き (▶)、開くと左へ出てくる向き (◀)
    collapseButton.textContent = next ? "◀" : "▶";
    collapseButton.title = next ? "開く" : "畳む";
    collapseButton.setAttribute("aria-expanded", next ? "false" : "true");
  }

  collapseButton.addEventListener("click", () => setCollapsed(!collapsed));
  setCollapsed(false);
  // 中身が入るまでは出さない。空の枠だけを出さない
  show(element, false);

  return {
    element,
    body,

    setVisible(visible): void {
      show(element, visible);
    },

    reveal(): void {
      if (collapsed) setCollapsed(false);
    },

    scrollTo(target): void {
      // 本体の外 (まだ入れていない・別の場所へ移った) なら送る先が無い
      if (!body.contains(target)) return;
      // **offsetTop ではなく画面上の位置の差で測る。** テロップの行は一覧の中の
      // 入れ子なので、offsetTop の基準の祖先が本体とずれる。
      // **scrollIntoView は使わない。** ページまで動かして動画の位置がずれうる
      const view = body.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      // 既に全部見えていれば動かさない。見ている位置が勝手に跳ねない
      if (rect.top >= view.top && rect.bottom <= view.bottom) return;
      body.scrollTop += rect.top - view.top;
    },

    destroy(): void {
      element.remove();
    },
  };
}
