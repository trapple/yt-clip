import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(new URL("../dist", import.meta.url));
/** 手動字幕 (英語ほか) と英語の自動字幕がある公開動画。音声トラックは 1 つ */
const CAPTIONED_VIDEO = "dQw4w9WgXcQ";

let context: BrowserContext;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-e2e-captions-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
    timeout: 60_000,
  });
});

test.afterAll(async () => {
  await context?.close();
  await rm(userDataDir, { recursive: true, force: true });
});

/**
 * ページの文脈 (MAIN world) から、隔離された world と同じ形で一覧だけを頼む。答えが無ければ null。
 * **待ちは頼む側 (caption-source) の pot の待ちと同じ 11 秒**: ブリッジは頼みを 1 本ずつ答えるので、拡張自身が
 * ページを開いたときに頼んだ pot の取得 (最長 8 秒) の後ろに並ぶことがある
 */
function askBridge(page: Page, videoId: string): Promise<unknown> {
  return page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const requestId = `e2e-${Math.random()}`;
        const timer = setTimeout(() => resolve(null), 11_000);
        window.addEventListener("message", (event) => {
          const data = event.data as { type?: string; id?: string } | null;
          if (data?.type === "yt-clip/captions-response" && data.id === requestId) {
            clearTimeout(timer);
            resolve(data);
          }
        });
        window.postMessage(
          { type: "yt-clip/captions-request", id: requestId, videoId: id, wantPot: false },
          location.origin,
        );
      }),
    videoId,
  );
}

test("MAIN world のブリッジが、字幕の一覧と吹き替えの判定を返す", async () => {
  const page = await context.newPage();
  try {
    await page.goto(`https://www.youtube.com/watch?v=${CAPTIONED_VIDEO}`, { timeout: 60_000 });
    // プレイヤーの応答が用意されるまで (広告が先に流れることがある) 頼み直す
    await expect
      .poll(async () => ((await askBridge(page, CAPTIONED_VIDEO)) as { ok?: boolean } | null)?.ok, { timeout: 45_000 })
      .toBe(true);
    const answer = (await askBridge(page, CAPTIONED_VIDEO)) as {
      ok: true;
      tracks: { languageCode: string; kind: string }[];
      potUrl: string | null;
      dubbed: boolean;
    };
    expect(answer.potUrl).toBeNull();
    expect(answer.dubbed).toBe(false);
    expect(answer.tracks.map((track) => `${track.languageCode}:${track.kind}`)).toContain("en:asr");
    // 別の動画を頼まれたら、まだ切り替わっていないと答える (SPA 遷移の直後と同じ)
    expect(await askBridge(page, "another-video")).toMatchObject({ ok: false, reason: "video-mismatch" });
  } finally {
    await page.close();
  }
});
