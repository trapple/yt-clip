// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CHANNEL, makeVideoMeta } from "../helpers/fixtures";
import { stubClientSize } from "../helpers/viewport";
import type { Message } from "@/shared/messages";
import type { ClipState } from "@/shared/types";

/**
 * 覚えた配置に枠 (docks) と v2 の float があるときの読み込み (窓の分割の spec C2.6)。
 *
 * youtube.ts は import した時点で覚えた配置を 1 度だけ読むので、古い形 (v1) を読ませている youtube.test.ts とは
 * 別のファイルにする (vitest はファイルごとにモジュールを読み直す)。ここでは v2 の組を読ませる:
 * バーは下の枠、区間・テロップの窓は右の枠 (float にもある。枠を採る)、設定の窓は float の位置 (C1 から持ち越した
 * 「float.settings を読み込みで当てる経路」の検査)。
 *
 * **canvas の getContext は stub しない。** 流す状態 (READY) はテロップが空で、プレビューは描かない。テロップ付きの状態を
 * 流す検査を足すときは、youtube.test.ts の spyOnGetContext と同じ扱いにする (jsdom の "Not implemented" が出力に混ざるため)
 */

const META = makeVideoMeta({ videoId: "video-a", title: "動画 A" });
const READY: ClipState = {
  kind: "ready",
  segments: [{ startSec: 10, endSec: 20 }],
  telops: [],
  meta: META,
};
/** 設定の窓の覚えた位置 (jsdom の画面 1024x768 に収まる値) */
const SETTINGS_RECT = { left: 200, top: 150, width: 360, height: 300 };
const LAYOUT_AT_LOAD = {
  version: 2,
  float: { list: { left: 50, top: 60, width: 320 }, settings: SETTINGS_RECT },
  docks: { below: { tabs: ["bar"] }, side: { tabs: ["list"], active: "list" } },
};

/** chrome.storage.local へ書いた windowLayout。書いた順 */
const layoutWrites: unknown[] = [];
/** 覚えた配置の読み込みを止めておく。止めている間に「枠も窓も出ていない」ことを確かめる */
let releaseLayout: () => void = () => undefined;
const layoutGate = new Promise<void>((resolve) => {
  releaseLayout = resolve;
});
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

/** 動画ページの骨組み (差す先 #below と #secondary > #secondary-inner、タイトル、チャンネル、プレイヤー、動画) */
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
  // チャンネル (構造化データのハンドル)。⚙ で開いた設定パネルがチャンネルを読むので、無いと warn が出力に混ざる
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

function tabLabels(slot: "below" | "side"): string[] {
  return [...byId(`yt-clip-dock-${slot}`).querySelectorAll<HTMLElement>("[data-role='dock-tab']")]
    .filter((tab) => tab.style.display !== "none")
    .map((tab) => tab.textContent ?? "");
}

/** 読み込む前の様子 (枠と 3 つの窓が出ているか) */
let beforeLoad = { slotsShown: [] as boolean[], windowsHidden: [] as boolean[] };

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
  // jsdom は Pointer Capture も ResizeObserver も持たない
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
        get: async (key?: string): Promise<Record<string, unknown>> => {
          // オン / オフ (無い = オン) は門を通さない。止めると start() も止まり、「読み込むまでは枠も窓も出さない」を
          // 確かめる前に窓そのものが無い
          if (key === "enabled") return {};
          await layoutGate;
          return { windowLayout: LAYOUT_AT_LOAD };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          layoutWrites.push(items.windowLayout);
        },
      },
      onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
    },
    runtime: {
      onMessage: {
        addListener: (fn: typeof onMessage): void => {
          onMessage = fn;
        },
        removeListener: (): void => undefined,
      },
      sendMessage: async (): Promise<{ state: ClipState }> => ({ state: READY }),
    },
  });

  await import("@/content/youtube");
  await flush();
  beforeLoad = {
    slotsShown: ["below", "side"].map(
      (slot) => document.getElementById(`yt-clip-dock-${slot}`)?.style.display === "block",
    ),
    windowsHidden: ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"].map(
      (id) => byId(id).hidden,
    ),
  };
  releaseLayout();
  await flush();
  // エディットモードで区間があるので、区間・テロップの窓を出す条件を満たす
  onMessage?.({ type: "state/changed", state: READY }, {}, () => undefined);
  await flush();
});

afterAll(async () => {
  // youtube.ts の MutationObserver は解除できない。youtube.test.ts と同じく、保留中の DOM 変化を出し切り、
  // observer が見ていない空の body に差し替えて終える
  document.body.innerHTML = "";
  await flush();
  document.documentElement.replaceChild(document.createElement("body"), document.body);
  await flush();
});

describe("覚えた枠を読み込む", () => {
  test("読み込むまでは、枠も窓も出さない (浮いた窓で出してから枠へ跳ぶ絵にしない)", () => {
    expect(beforeLoad.slotsShown).toEqual([false, false]);
    expect(beforeLoad.windowsHidden).toEqual([true, true, true]);
  });

  test("読み込みは保存しない", () => {
    expect(layoutWrites).toEqual([]);
  });

  test("覚えた docks どおり、バーは #below の枠、区間・テロップの窓は #secondary-inner の枠に入る (float にもある窓は枠を採る)", () => {
    const below = byId("yt-clip-dock-below");
    const side = byId("yt-clip-dock-side");
    expect(below.parentElement?.id).toBe("below");
    expect(side.parentElement?.id).toBe("secondary-inner");
    expect(below.contains(byId("yt-clip-bar-window"))).toBe(true);
    expect(side.contains(byId("yt-clip-list"))).toBe(true);
    expect(byId("yt-clip-list").style.position).toBe("static");
    expect(below.style.display).toBe("block");
    expect(side.style.display).toBe("block");
    // バーだけの枠はタブの列を出さない。区間・テロップの窓だけの枠は出す
    expect(tabLabels("below")).toEqual([]);
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
  });

  test("覚えた float.settings の位置に、⚙ で開いた設定の窓を出す", async () => {
    const gear = [...document.querySelectorAll<HTMLButtonElement>("#yt-clip-bar button")].find(
      (button) => button.textContent === "⚙",
    );
    if (gear === undefined) throw new Error("⚙ がありません");
    gear.click();
    await flush();

    const settings = byId("yt-clip-settings");
    expect(settings.parentElement).toBe(document.body);
    expect(settings.hidden).toBe(false);
    expect({
      left: settings.style.left,
      top: settings.style.top,
      width: settings.style.width,
      height: settings.style.height,
    }).toEqual({ left: "200px", top: "150px", width: "360px", height: "300px" });
  });

  test("#secondary が無くなると区間・テロップの窓は最初の位置の浮いた窓で出て (float に位置があっても)、戻ると枠に戻る", async () => {
    const secondary = byId("secondary");
    secondary.remove();
    await flush();

    const list = byId("yt-clip-list");
    expect(list.parentElement).toBe(document.body);
    expect(list.style.position).toBe("fixed");
    expect({ left: list.style.left, top: list.style.top, width: list.style.width }).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "68px",
      width: "400px",
    });

    document.body.append(secondary);
    await flush();
    expect(byId("yt-clip-dock-side").contains(list)).toBe(true);
    expect(list.style.position).toBe("static");
  });
});
