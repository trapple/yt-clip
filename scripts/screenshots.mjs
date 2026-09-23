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

  /** バーが画面の下寄りに来るよう送る。プレイヤーと操作の両方を 1 枚に収める */
  const framePlayerAndBar = async (ratio) => {
    await page.evaluate((r) => {
      const element = document.getElementById("yt-clip-bar");
      if (element === null) throw new Error("バーが見つかりません");
      const top = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top - window.innerHeight * r, behavior: "instant" });
    }, ratio);
    // スクロール後の再描画を待つ
    await page.waitForTimeout(500);
  };

  await framePlayerAndBar(0.72);
  await page.screenshot({ path: `${OUT_DIR}/1-range.png` });
  console.log(`${OUT_DIR}/1-range.png`);

  /**
   * バー全体 (開いているパネルも含む) が画面に収まるよう送る。
   *
   * **上端ではなく下端を基準にする。** 設定項目が増えるとパネルは下へ伸びるので、
   * 上端を固定していると新しい項目が画面外へこぼれる (モードを足したときに
   * 「最大秒数」が切れた)
   */
  const frameWholeBar = async (bottomMarginPx) => {
    await page.evaluate((margin) => {
      const element = document.getElementById("yt-clip-bar");
      if (element === null) throw new Error("バーが見つかりません");
      const bottom = element.getBoundingClientRect().bottom + window.scrollY;
      window.scrollTo({
        top: bottom - window.innerHeight + margin,
        behavior: "instant",
      });
    }, bottomMarginPx);
    // スクロール後の再描画を待つ
    await page.waitForTimeout(500);
  };

  // 設定パネルを開く。パネルのぶん背が伸びるので枠取りを取り直す
  await bar.getByRole("button", { name: "⚙" }).click();
  await frameWholeBar(24);
  await page.screenshot({ path: `${OUT_DIR}/2-settings.png` });
  console.log(`${OUT_DIR}/2-settings.png`);
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}
