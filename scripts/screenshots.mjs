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
  // **右の列 (#secondary) そのものは残す**: 列ごと隠すとプレイヤーの幅が実際の YouTube と変わる
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
  // IN は状態機械の答えを待って描く (モードを無くした版から楽観描画をやめた)。状態の欄が範囲 (「…秒)」) になり、
  // 区間・テロップの窓が出るまで待つ。欄そのものは初めからあるので、要素の有無だけを待つとすぐ返って撮り損ねる
  await page.locator("#yt-clip-bar-status", { hasText: "秒)" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.locator("#yt-clip-list").waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });

  /**
   * ページの先頭へ戻す。最初の配置ではバーはプレイヤーの直下 (#below の先頭の枠) に
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

  // 設定は popup にある (settings-in-popup spec)。ツールバーの popup そのものは Playwright から開けないので、
  // popup のページを 1280x800 の中央に置いて撮る (store-release.md)。拡張の id は service worker の URL から取る
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: WAIT_TIMEOUT_MS }));
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: WIDTH, height: HEIGHT });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
    timeout: NAV_TIMEOUT_MS,
  });
  await popup
    .getByRole("button", { name: "保存" })
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
  await popup.addStyleTag({
    content:
      "html { min-height: 100%; display: flex; align-items: center; justify-content: center; background: #e5e5e5; }" +
      " body { box-shadow: 0 4px 16px rgba(0,0,0,0.25); border-radius: 8px; }",
  });
  await popup.screenshot({ path: `${OUT_DIR}/2-settings.png` });
  console.log(`${OUT_DIR}/2-settings.png`);
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}
