// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CHANNEL, makeVideoMeta } from "../helpers/fixtures";
import { ourElements } from "../helpers/our-elements";
import { stubClientSize } from "../helpers/viewport";
import type { Message } from "@/shared/messages";
import type { ClipState } from "@/shared/types";

/**
 * 動画ページ以外 (ホーム) で読み込まれた content script (spa-inject の不具合修正)。
 *
 * YouTube の中の移動は SPA なので、ホーム・検索結果から動画へ入ってもドキュメントの読み込みは起きない。content script は
 * youtube.com の全ページで読み込み、**動画ページ以外ではページに何も差さない** (dockable-windows の spec C2.7)。
 * youtube.ts は import した時点の URL で start() を走らせるので、動画ページで読ませる youtube.test.ts とは別のファイルにする。
 *
 * **差す先 (#below / #secondary-inner) とシークバーはホームにも置いておく。** YouTube は動画ページからホームへ移っても
 * 隠れた ytd-watch-flexy を残すので、「差す先が無いから差さない」ではなく URL で決めていることを確かめる
 */

type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

const META = makeVideoMeta({ videoId: "video-a", title: "動画 A" });
const READY: ClipState = {
  kind: "ready",
  segments: [{ startSec: 10, endSec: 20 }],
  telops: [],
  meta: META,
};

const storageListeners: StorageListener[] = [];
let onMessage:
  | ((message: Message, sender: unknown, sendResponse: (response?: unknown) => void) => void)
  | null = null;

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function boxAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 動画ページの骨組み (差す先・タイトル・チャンネル・プレイヤー・シークバー・動画)。ホームでも残っている形 */
function buildPage(): void {
  const below = document.createElement("div");
  below.id = "below";
  const secondary = document.createElement("div");
  secondary.id = "secondary";
  const inner = document.createElement("div");
  inner.id = "secondary-inner";
  secondary.append(inner);
  const title = document.createElement("h1");
  title.className = "ytd-watch-metadata";
  const titleText = document.createElement("yt-formatted-string");
  titleText.textContent = META.title;
  title.append(titleText);
  const author = document.createElement("span");
  author.setAttribute("itemprop", "author");
  const authorUrl = document.createElement("link");
  authorUrl.setAttribute("itemprop", "url");
  authorUrl.setAttribute("href", `/${META.channelId}`);
  const authorName = document.createElement("link");
  authorName.setAttribute("itemprop", "name");
  authorName.setAttribute("content", CHANNEL.name);
  author.append(authorUrl, authorName);
  const player = document.createElement("div");
  player.id = "movie_player";
  const progress = document.createElement("div");
  progress.className = "ytp-progress-bar";
  player.append(progress);
  const video = document.createElement("video");
  video.className = "html5-main-video";
  Object.defineProperty(video, "duration", { configurable: true, value: 600 });
  document.body.append(below, secondary, title, author, player, video);
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} がありません`);
  return element;
}

/** SPA の移動 (URL を変えて DOM を変える。observer が拾う) */
async function navigate(path: string): Promise<void> {
  history.pushState({}, "", path);
  document.body.append(document.createElement("div"));
  await flush();
}

/** YouTube の要素の中に差したものの数 (#below・#secondary-inner・シークバー) */
function insertedIntoYouTube(): number[] {
  return ["#below", "#secondary-inner", ".ytp-progress-bar"].map(
    (selector) => document.querySelector(selector)?.childElementCount ?? -1,
  );
}

beforeAll(async () => {
  buildPage();
  stubClientSize();
  // 差す先に幅を持たせる (jsdom はレイアウトを持たず、幅 0 の枠は使えない扱いになる)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (this.id === "below") return boxAt(0, 600, 800, 0);
    if (this.id === "secondary-inner") return boxAt(840, 60, 400, 0);
    return boxAt(0, 0, 0, 0);
  });
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: async (): Promise<Record<string, unknown>> => ({ settings: { mode: "edit" } }),
        set: async (): Promise<void> => undefined,
      },
      local: {
        // オン / オフは無い = オン。覚えた配置も無い (最初の配置: バーは下の枠)
        get: async (): Promise<Record<string, unknown>> => ({}),
        set: async (): Promise<void> => undefined,
      },
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListeners.push(fn);
        },
        removeListener: (fn: StorageListener): void => {
          const index = storageListeners.indexOf(fn);
          if (index >= 0) storageListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: typeof onMessage): void => {
          onMessage = fn;
        },
        removeListener: (): void => {
          onMessage = null;
        },
      },
      // 状態の取り戻しは、動画 A の範囲を持った ready を返す (別のタブで作った範囲。ホームでは何も出さない)
      sendMessage: async (): Promise<{ state: ClipState }> => ({ state: READY }),
    },
  });

  await import("@/content/youtube");
  await flush();
});

afterAll(async () => {
  // オフにすれば observer も listener も外れる
  for (const listener of [...storageListeners]) listener({ enabled: { newValue: false } }, "local");
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("動画ページ以外で読み込む", () => {
  test("オンでも、ホームではページに何も足さず、YouTube の要素の中にも何も差さない", () => {
    expect(ourElements()).toBe(0);
    expect(insertedIntoYouTube()).toEqual([0, 0, 0]);
  });

  test("ホームで DOM が変わっても何も差さない", async () => {
    document.body.append(document.createElement("div"));
    await flush();
    expect(ourElements()).toBe(0);
    expect(insertedIntoYouTube()).toEqual([0, 0, 0]);
  });

  test("SPA で動画ページへ移ると、読み込み直さずにバーが出る", async () => {
    await navigate("/watch?v=video-a");

    expect(document.getElementById("yt-clip-bar")).not.toBeNull();
    expect(byId("yt-clip-bar-window").hidden).toBe(false);
    // 最初の配置: バーはプレイヤーの下の枠
    expect(byId("yt-clip-dock-below").parentElement?.id).toBe("below");
    expect(byId("yt-clip-dock-below").contains(byId("yt-clip-bar-window"))).toBe(true);
  });

  test("動画ページから SPA でホームへ戻ると、枠・窓・帯が残らない。もう一度動画へ入ると同じ枠に出る", async () => {
    // 範囲を持たせて、区間・テロップの窓とシークバーの帯も出す
    onMessage?.({ type: "state/changed", state: READY }, {}, () => undefined);
    await flush();
    expect(byId("yt-clip-list").hidden).toBe(false);
    expect(document.querySelector(".ytp-progress-bar")?.childElementCount).toBe(1);

    await navigate("/");
    expect(ourElements()).toBe(0);
    expect(insertedIntoYouTube()).toEqual([0, 0, 0]);

    await navigate("/watch?v=video-a");
    expect(byId("yt-clip-bar-window").hidden).toBe(false);
    expect(byId("yt-clip-dock-below").parentElement?.id).toBe("below");
    expect(byId("yt-clip-dock-below").contains(byId("yt-clip-bar-window"))).toBe(true);
    expect(byId("yt-clip-list").hidden).toBe(false);
  });

  test("ホームにいる間に届いた状態も、外していたバーに描く (戻ったときに古い操作が出ない)", async () => {
    const recordButtons = (): number =>
      [...byId("yt-clip-bar").querySelectorAll("button")].filter(
        (button) => button.textContent === "● 録画",
      ).length;
    onMessage?.({ type: "state/changed", state: READY }, {}, () => undefined);
    await flush();
    expect(recordButtons()).toBe(1);

    await navigate("/");
    // 別のタブで範囲を捨てた (ホームにいる間に idle が届く)
    onMessage?.({ type: "state/changed", state: { kind: "idle" } }, {}, () => undefined);
    await flush();

    await navigate("/watch?v=video-a");
    expect(recordButtons()).toBe(0);
  });
});
