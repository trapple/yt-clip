import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import { SIDE_PANEL_STYLE } from "@/content/styles";
import { MASTHEAD_HEIGHT_PX, TOP_GAP_PX, type Viewport } from "@/content/window-layout";

/**
 * 画面右側のパネル。区間の一覧・テロップの一覧・設定を入れる
 * (`.claude/specs/2026-09-24-side-panel-design.md`)。**フロートの窓 (`floating-window.ts`) の
 * 上に作る** (`.claude/specs/2026-09-24-floating-windows-design.md` A.3)。
 *
 * **中身の箱と折り畳みだけを持つ。** 窓の枠 (見出し・ドラッグ・大きさ・画面に詰める・重なり順) は
 * floating-window.ts、何を入れるか・いつ出すか・どこへ置くかは youtube.ts が決める。
 * 出すかの理由をここにも持たせると、2 箇所の判定が食い違ったときにどちらが正か分からなくなる
 */

export const SIDE_PANEL_ID = "yt-clip-panel";
export const SIDE_PANEL_BODY_ID = `${SIDE_PANEL_ID}-body`;

/*
 * 最初の位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020、#secondary の幅 544px。
 * ヘッダーの高さとの間 (MASTHEAD_HEIGHT_PX / TOP_GAP_PX) はバーの窓の上端の下限と共有するので
 * window-layout.ts に置く。
 * z-index は「ヘッダー (#masthead-container、z-index 2020) より下」であることだけ実測
 * (重なり順の値は floating-window.ts の Z_BACK / Z_FRONT が持つ)。
 * ヘッダーのメニュー本体は自前の z-index を持つため測っておらず、ytd-popup-container の
 * z-index auto はその根拠にならない。#secondary の幅は viewport で変わるので WIDTH_PX の
 * doc に別で書く。YouTube のレイアウトが変わったら測り直す
 */
/** 画面の右端との間 (下端との間 16px は floating-window.ts の BOTTOM_GAP_PX) */
const EDGE_GAP_PX = 16;
/**
 * #secondary の幅は viewport で変わる (1920x1080 で 544px、実測)。400px は
 * 1440x795 (受け入れ条件の viewport) でもプレイヤーに重ならない幅
 * (実測: プレイヤーの右端 1012px < パネルの左端 1024px)
 */
const WIDTH_PX = 400;
/** 大きさを変えられる下限 (spec A.1)。これより小さいと一覧の 1 行が読めない */
const MIN_WIDTH_PX = 280;
const MIN_HEIGHT_PX = 160;

export type SidePanel = {
  element: HTMLElement;
  /** 中身の箱。区間の一覧・テロップの一覧・設定パネルをこの順に入れる */
  body: HTMLElement;
  /**
   * 出すか隠すか。**理由の計算は youtube.ts の 1 箇所に置く** (中身が無い / 全画面 / 動画ページ以外 /
   * 覚えた位置の読み込み前、のどれかなら隠す)。パネルは理由を知らない
   */
  setVisible(visible: boolean): void;
  /** 畳んでいれば開く (設定を開いた・区間やテロップを足したとき) */
  reveal(): void;
  /** 本体の中だけをスクロールして、target の先頭を見える範囲に入れる */
  scrollTo(target: HTMLElement): void;
  destroy(): void;
  /**
   * パネルの窓の枠。**位置と大きさ (place / rect) は youtube.ts が決める** (最初の位置・
   * 覚えた位置・取り直し)。出し入れは setVisible を使う
   */
  frame: FloatingWindow;
};

export type SidePanelOptions = {
  /** 見出しをドラッグして動かした・右下で大きさを変えた (指を離した時点で 1 回) */
  onUserMove?(rect: WindowRect): void;
  /** 見出しのダブルクリック (最初の位置に戻す) */
  onResetRequest?(): void;
};

/**
 * パネルの窓の最初の位置 (spec A.2: 今の右側パネルと同じ)。右端から EDGE_GAP_PX、ヘッダーの
 * 下 TOP_GAP_PX、幅 WIDTH_PX。**高さは決めない** (中身まで伸び、画面の下端から 16px で止まる)
 */
export function initialPanelRect(viewport: Viewport): WindowRect {
  return {
    left: viewport.width - EDGE_GAP_PX - WIDTH_PX,
    top: MASTHEAD_HEIGHT_PX + TOP_GAP_PX,
    width: WIDTH_PX,
  };
}

export function createSidePanel(options: SidePanelOptions = {}): SidePanel {
  const frame = createFloatingWindow({
    id: SIDE_PANEL_ID,
    title: "yt-clip",
    resize: "both",
    minWidth: MIN_WIDTH_PX,
    minHeight: MIN_HEIGHT_PX,
    onUserMove: (rect) => options.onUserMove?.(rect),
    onResetRequest: () => options.onResetRequest?.(),
  });
  const { element, body, headerActions } = frame;
  // 見出しのある窓は必ず見出しの箱を持つ。無ければ floating-window.ts の不具合なので隠さない
  if (headerActions === null) throw new Error("パネルの窓に見出しの箱がありません");

  body.id = SIDE_PANEL_BODY_ID;
  body.style.cssText = SIDE_PANEL_STYLE.body;

  const collapseButton = document.createElement("button");
  collapseButton.dataset.role = "collapse";
  collapseButton.style.cssText = SIDE_PANEL_STYLE.collapseButton;
  headerActions.append(collapseButton);

  // 作った直後から今の右側パネルと同じ所に置く。youtube.ts も出すときに置き直す
  frame.place(initialPanelRect({ width: window.innerWidth, height: window.innerHeight }));

  /**
   * 畳んでいるか。**タブを開いている間だけ覚える** (保存しない)。保存すると
   * 「パネルが出ない」という相談の原因になりやすく、得るものが小さい
   */
  let collapsed = false;

  /**
   * 本体の出し入れは `hidden` と `style.display` の両方で行う。**`hidden` だけに頼らない。**
   * 本体は flex で並べるので display を持つ。inline の display は UA の
   * `[hidden] { display: none }` に勝ち、`hidden` を立てても出たままになる。
   * `hidden` は外から「畳んでいるか」を読むため (と、窓の枠が高さを外すため) に残す
   */
  function show(target: HTMLElement, visible: boolean): void {
    target.hidden = !visible;
    target.style.display = visible ? "flex" : "none";
  }

  function setCollapsed(next: boolean): void {
    collapsed = next;
    show(body, !next);
    // 開いているときは ▶ (押すと右へ畳む)、畳んでいるときは ◀ (押すと左へ開く)
    collapseButton.textContent = next ? "◀" : "▶";
    collapseButton.title = next ? "開く" : "畳む";
    collapseButton.setAttribute("aria-expanded", next ? "false" : "true");
    // 窓の枠は、置くときに本体の出し入れを見て高さを外す (畳んだ窓に空の枠を残さない)。
    // 高さを決めた窓でも見出しだけになるよう、置いた場所から詰め直す。place(rect()) にしない:
    // 狭い画面で詰まった位置が「置いた場所」になり、広げ直しても戻らなくなる
    frame.refit();
  }

  collapseButton.addEventListener("click", () => setCollapsed(!collapsed));
  setCollapsed(false);

  return {
    element,
    body,
    frame,

    setVisible(visible): void {
      frame.setVisible(visible);
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
      frame.destroy();
    },
  };
}
