/**
 * ウェブストア掲載用のスクリーンショットを撮る。
 *
 *   npm run screenshots
 *
 * 1280x800 で `release/screenshots/` に書き出す。
 *
 * **題材は Big Buck Bunny (Blender Foundation, Creative Commons)。**
 * 掲載画像には動画の中身がそのまま写るので、権利関係で問題にならないものを使う。
 *
 * X の投稿画面はログインが要るため自動化していない。手で撮ること。
 */
import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(new URL("../dist", import.meta.url));
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const OUT_DIR = "release/screenshots";

/** ストアが受け付ける寸法 */
const WIDTH = 1280;
const HEIGHT = 800;

/** ブラウザ起動やページ遷移が固まったまま待ち続けないようにする */
const LAUNCH_TIMEOUT_MS = 60_000;
const NAV_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 30_000;

const userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-shot-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  viewport: { width: WIDTH, height: HEIGHT },
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${WIDTH},${HEIGHT}`,
  ],
  timeout: LAUNCH_TIMEOUT_MS,
});

try {
  mkdirSync(OUT_DIR, { recursive: true });
  const page = await context.newPage();
  await page.goto(VIDEO, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });

  // **関連動画を隠す。** 掲載画像に他人の動画のサムネイルが写り込むのを避ける。
  // 拡張と関係ない要素が減って、見せたいものにも目が行く
  await page.addStyleTag({
    content: "#secondary, ytd-watch-next-secondary-results-renderer { display: none !important; }",
  });

  const bar = page.locator("#yt-clip-bar");
  await bar.waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
  // タイトルが埋まる前に IN を押すとメタ情報を取れずに失敗する (E2E と同じ理由)
  await page
    .locator("h1.ytd-watch-metadata yt-formatted-string")
    .filter({ hasNotText: /^$/ })
    .first()
    .waitFor({ timeout: WAIT_TIMEOUT_MS });

  // 絵として分かりやすい場面で止める。再生したままだと撮るたびに絵が変わる
  await page.evaluate(() => {
    const video = document.querySelector("video.html5-main-video");
    if (video === null) throw new Error("video 要素が見つかりません");
    video.currentTime = 40;
    video.pause();
  });

  await bar.getByRole("button", { name: "IN" }).click();
  await page.locator("#yt-clip-bar-status").waitFor({ timeout: WAIT_TIMEOUT_MS });

  /**
   * バーの窓が画面の下寄り (上端が画面の高さの ratio) に来るよう送る。プレイヤーと操作の両方を
   * 1 枚に収める。
   *
   * **バーの窓はページのスクロールに付いてこない** (画面に浮いたまま。フロートの窓の spec A.2)。
   * 送った後に resize を配り、動かしていないバーの窓に最初の位置 (その時点のプレイヤーの
   * 下端 + 8px。youtube.ts / window-layout.ts の BAR_GAP_PX) を取り直させる
   */
  const framePlayerAndBar = async (ratio) => {
    await page.evaluate((r) => {
      const player = document.getElementById("movie_player");
      if (player === null) throw new Error("プレイヤーが見つかりません");
      const barTop = player.getBoundingClientRect().bottom + 8 + window.scrollY;
      window.scrollTo({ top: barTop - window.innerHeight * r, behavior: "instant" });
      window.dispatchEvent(new Event("resize"));
    }, ratio);
    // スクロールと置き直しの後の再描画を待つ
    await page.waitForTimeout(500);
  };

  await framePlayerAndBar(0.72);
  await page.screenshot({ path: `${OUT_DIR}/1-range.png` });
  console.log(`${OUT_DIR}/1-range.png`);

  // 設定を開く。**設定は右側の固定のパネルに開き、ページのスクロールでは動かない。**
  // 枠取りは 1-range と同じ (プレイヤーとバーが下寄り) にして、パネルの中を設定の
  // 先頭まで送って撮る。1280x800 ではパネルの最大高さ (716px) に 8 項目と保存ボタンが
  // 収まらず末尾は切れるが、それでよい。パネルの中でスクロールすることが見て分かる
  await bar.getByRole("button", { name: "⚙" }).click();
  await page
    .locator("#yt-clip-panel")
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });

  // **このスクリーンショットだけ**、動画 (#primary) の幅をパネルのぶん空ける。
  // 掲載画像はおすすめ列 (#secondary) を隠しているのでプレイヤーが画面右端まで
  // 広がり、固定パネルと重なって「動画は隠れない」設計と食い違う絵になる。実際の
  // YouTube にはおすすめ列があるので重ならない (1440 幅の実測で
  // playerRight 1012 < panel.left 1024)。
  // 実測 (1280x800、YouTube 2026-09-24): #secondary を隠すと #columns は
  // justify-content: center になり、max-width だけ足すとプレイヤーが中央へ
  // 寄って逆に重なりが深くなる (primary right 1072 > panel.left 864) ので、
  // 左詰めに戻す指定も一緒に足す。448 = パネル幅 400 + 右端の余白 16 +
  // プレイヤー側の左マージン 32 (side-panel.ts の WIDTH_PX / EDGE_GAP_PX と対応)
  await page.addStyleTag({
    content:
      "#columns { justify-content: flex-start !important; } #primary { max-width: calc(100vw - 448px) !important; }",
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const body = document.getElementById("yt-clip-panel-body");
    // 設定パネルの根は、最初の項目 (モード) の入力欄 → 項目の枠 → 根
    const settings = document.getElementById("yt-clip-setting-mode")?.parentElement
      ?.parentElement;
    if (body === null || settings == null) {
      throw new Error("パネルか設定が見つかりません");
    }
    // 拡張も ⚙ で送っているが、掲載画像の絵をここで確定させる (拡張の振る舞いが
    // 変わっても、撮れる絵が変わらないように)
    body.scrollTop +=
      settings.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  await framePlayerAndBar(0.72);
  await page.screenshot({ path: `${OUT_DIR}/2-settings.png` });
  console.log(`${OUT_DIR}/2-settings.png`);
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}
