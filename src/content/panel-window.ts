import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import { PANEL_WINDOW_STYLE } from "@/content/styles";
import { MASTHEAD_HEIGHT_PX, TOP_GAP_PX, type Viewport } from "@/content/window-layout";

/**
 * 見出しのある「幅と高さ」の窓 (`.claude/specs/2026-09-25-dockable-windows-design.md` C1.4)。
 * 区間・テロップの窓と設定の窓の両方をこれで作る。**フロートの窓 (`floating-window.ts`) の上に作る。**
 *
 * **中身の箱 (余白・スクロール) と scrollTo だけを持つ。** 窓の枠 (見出し・ドラッグ・大きさ・画面に
 * 詰める・重なり順) は floating-window.ts、何を入れるか・いつ出すか・どこへ置くかは youtube.ts が決める。
 * 出すかの理由をここにも持たせると、2 箇所の判定が食い違ったときにどちらが正か分からなくなる。
 *
 * **折り畳み (▶) は持たない** (C1.2)。動かせる窓になり、重なるときは動かせば済む。残すと
 * 「畳んだ × 重なり順 (C2 ではドック中 × タブが前)」の組み合わせが増える
 */

/*
 * 最初の位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」(当時の名前。今は
 * 「窓の位置の出所 (YouTube の実測)」) で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020、#secondary の幅 544px。
 * ヘッダーの高さとの間 (MASTHEAD_HEIGHT_PX / TOP_GAP_PX) はバーの窓の上端の下限と共有するので
 * window-layout.ts に置く。
 * z-index は「ヘッダー (#masthead-container、z-index 2020) より下」であることだけ実測
 * (重なり順の値は floating-window.ts の Z_BASE が持つ)。
 * ヘッダーのメニュー本体は自前の z-index を持つため測っておらず、ytd-popup-container の
 * z-index auto はその根拠にならない。#secondary の幅は viewport で変わるので WIDTH_PX の
 * doc に別で書く。YouTube のレイアウトが変わったら測り直す
 */
/** 画面の右端との間 (下端との間 16px は floating-window.ts の BOTTOM_GAP_PX) */
const EDGE_GAP_PX = 16;
/**
 * #secondary の幅は viewport で変わる (1920x1080 で 544px、実測)。400px は
 * 1440x795 (受け入れ条件の viewport) でもプレイヤーに重ならない幅
 * (実測: プレイヤーの右端 1012px < 窓の左端 1024px)
 */
const WIDTH_PX = 400;
/** 大きさを変えられる下限 (フロートの窓の spec A.1。C1.1 で両方の窓に同じ値)。これより小さいと一覧の 1 行が読めない */
const MIN_WIDTH_PX = 280;
const MIN_HEIGHT_PX = 160;
/**
 * 設定の窓を区間・テロップの窓からずらす量 (下へだけ。C1.3 のカスケード)。一覧の見出しの行 (32px) が
 * 設定の窓の上に残って見え、掴んで動かせる。完全に重ねない: ⚙ を押した瞬間に一覧が丸ごと隠れると、
 * 分けた意味 (両方を同時に見る) が薄い。**左右にはずらさない:** 1440x795 で一覧の left は 1024px、
 * プレイヤーの右端は 1012px (実測) なので、左へ 32px ずらすとプレイヤーに 20px 重なる。右へは画面の
 * 右端で詰められて同じ位置になる
 */
export const SETTINGS_CASCADE_PX = 32;

export type PanelWindow = {
  element: HTMLElement;
  /** 中身の箱。区間・テロップの窓には区間の一覧とテロップの一覧、設定の窓には設定パネルを入れる */
  body: HTMLElement;
  /**
   * 出すか隠すか。**理由の計算は youtube.ts の 1 箇所に置く** (中身が無い / 設定を閉じている /
   * 全画面 / 動画ページ以外 / 覚えた配置の読み込み前、のどれかなら隠す)。窓は理由を知らない
   */
  setVisible(visible: boolean): void;
  /** 中身の箱の中だけをスクロールして、target の先頭を見える範囲に入れる */
  scrollTo(target: HTMLElement): void;
  destroy(): void;
  /**
   * 窓の枠。**位置と大きさ (place / rect) は youtube.ts が決める** (最初の位置・
   * 覚えた位置・取り直し)。出し入れは setVisible を使う
   */
  frame: FloatingWindow;
};

export type PanelWindowOptions = {
  /** 窓の id ("yt-clip-list" / "yt-clip-settings")。中身の箱の id は `${id}-body` */
  id: string;
  /** 見出しの文言 ("区間・テロップ" / "設定")。C2 ではそのままタブの文言になる */
  title: string;
  /** 見出しをドラッグして動かした・右下で大きさを変えた (指を離した時点で 1 回) */
  onUserMove?(rect: WindowRect): void;
  /** 見出しのダブルクリック (最初の位置に戻す) */
  onResetRequest?(): void;
};

/**
 * 区間・テロップの窓の最初の位置 (C1.3: 今の右側パネルと同じ)。右端から EDGE_GAP_PX、
 * ヘッダーの下 TOP_GAP_PX、幅 WIDTH_PX。**高さは決めない** (中身まで伸び、画面の下端から 16px で止まる)
 */
export function initialListRect(viewport: Viewport): WindowRect {
  return {
    left: viewport.width - EDGE_GAP_PX - WIDTH_PX,
    top: MASTHEAD_HEIGHT_PX + TOP_GAP_PX,
    width: WIDTH_PX,
  };
}

/**
 * 設定の窓の最初の位置 (C1.3)。区間・テロップの窓の**最初の位置**から下へ SETTINGS_CASCADE_PX。
 * 一覧を動かした後の位置には付いていかない: 付けると、一覧を動かすたびに動かしていない設定の窓も
 * 置き直す経路が要り、1440x795 でプレイヤーに重ならない保証も最初の位置どうしでしか成り立たない
 */
export function initialSettingsRect(viewport: Viewport): WindowRect {
  const list = initialListRect(viewport);
  return { ...list, top: list.top + SETTINGS_CASCADE_PX };
}

/**
 * 窓を作る。**自分では最初の位置に置かない。** どちらの窓の最初の位置かは作る側 (youtube.ts) が
 * 知っており、窓を出した直後に置く (今のバーの窓と同じ経路)。隠れている間は寸法が 0 なので、
 * 作った時点で置いても出すときに置き直すことになる
 */
export function createPanelWindow(options: PanelWindowOptions): PanelWindow {
  const frame = createFloatingWindow({
    id: options.id,
    title: options.title,
    resize: "both",
    minWidth: MIN_WIDTH_PX,
    minHeight: MIN_HEIGHT_PX,
    onUserMove: (rect) => options.onUserMove?.(rect),
    onResetRequest: () => options.onResetRequest?.(),
  });
  const { element, body } = frame;

  body.id = `${options.id}-body`;
  body.style.cssText = PANEL_WINDOW_STYLE.body;

  return {
    element,
    body,
    frame,

    setVisible(visible): void {
      frame.setVisible(visible);
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
