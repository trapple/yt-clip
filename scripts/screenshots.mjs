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

  // **関連動画の中身を隠す。** 掲載画像に他人の動画のサムネイルが写り込むのを避ける。
  // **右の列 (#secondary) そのものは残す**: 最初の配置では区間・テロップと設定が右の列の先頭の枠に入る
  // (窓の分割の spec C2.6)。列ごと隠すと右の枠が使えない扱いになり、設定が浮いた窓で出て、実際の絵と違ってしまう
  await page.addStyleTag({
    content:
      "#related, #chat, ytd-watch-next-secondary-results-renderer { display: none !important; }",
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
   * ページの先頭へ戻す。最初の配置ではバーはプレイヤーの直下 (#below の先頭の枠)、設定はおすすめ動画の上の枠に
   * ページの一部として入っている (窓の分割の spec C2.6) ので、先頭のままでプレイヤーと操作の両方が 1 枚に入る
   * (1280x800 でプレイヤーの下端 + バー約 140px < 800)。浮いた窓の置き直し (resize) は要らなくなった
   */
  const frameTop = async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(500);
  };

  await frameTop();
  await page.screenshot({ path: `${OUT_DIR}/1-range.png` });
  console.log(`${OUT_DIR}/1-range.png`);

  // 設定を開く。最初の配置では、おすすめ動画の上の枠で設定のタブが前に出る (窓の分割の spec C2.2)。
  // ページの中の窓は中身なりに伸びるので、1280x800 では設定の末尾が画面の下で切れるが、それでよい
  await bar.getByRole("button", { name: "⚙" }).click();
  await page
    .locator("#yt-clip-settings")
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
  await frameTop();
  await page.screenshot({ path: `${OUT_DIR}/2-settings.png` });
  console.log(`${OUT_DIR}/2-settings.png`);
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}
