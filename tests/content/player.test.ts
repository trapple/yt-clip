// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=abc123" }
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ElementNotFoundError,
  getChannel,
  getVideoMeta,
  getVideo,
  onReachTime,
  parseVideoId,
  seekTo,
} from "@/content/player";
import { YT_SELECTORS } from "@/content/selectors";

describe("parseVideoId", () => {
  test("watch URL から videoId を取り出す", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  test("他のクエリが付いていても取り出せる", () => {
    expect(
      parseVideoId("https://www.youtube.com/watch?v=abc123&list=PL1&index=2"),
    ).toBe("abc123");
  });

  test("videoId が無い URL は throw する", () => {
    expect(() => parseVideoId("https://www.youtube.com/")).toThrow(
      "URL から videoId を取得できません",
    );
  });
});

describe("getVideo", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("video 要素を返す", () => {
    const video = document.createElement("video");
    video.className = "html5-main-video";
    document.body.appendChild(video);

    expect(getVideo()).toBe(video);
  });

  test("見つからなければ握り潰さず throw する", () => {
    expect(() => getVideo()).toThrow(ElementNotFoundError);
  });

  test("セレクタは selectors.ts に集約されている", () => {
    expect(YT_SELECTORS.video).toBe("video.html5-main-video");
  });
});

describe("seekTo", () => {
  test("seeked が来たら解決する", async () => {
    const video = document.createElement("video");
    const promise = seekTo(video, 42);
    video.dispatchEvent(new Event("seeked"));

    await expect(promise).resolves.toBeUndefined();
  });

  test("seeked が来なければタイムアウトで reject する", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const promise = seekTo(video, 42, 5000);
    const assertion = expect(promise).rejects.toThrow(
      "seek がタイムアウトしました",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("onReachTime", () => {
  /** requestVideoFrameCallback を手動で駆動できる video を作る */
  function makeVideoWithFrames() {
    const video = document.createElement("video");
    const pending: Array<(now: number, meta: { mediaTime: number }) => void> =
      [];
    Object.assign(video, {
      requestVideoFrameCallback: (
        cb: (now: number, meta: { mediaTime: number }) => void,
      ) => {
        pending.push(cb);
        return pending.length;
      },
      cancelVideoFrameCallback: () => {
        pending.length = 0;
      },
    });
    const advanceTo = (mediaTime: number) => {
      const callbacks = [...pending];
      pending.length = 0;
      for (const cb of callbacks) cb(0, { mediaTime });
    };
    return { video, advanceTo, pending };
  }

  test("指定位置に到達したらコールバックを呼ぶ", () => {
    const { video, advanceTo } = makeVideoWithFrames();
    const onReach = vi.fn();
    onReachTime(video, 40, onReach);

    advanceTo(39.9);
    expect(onReach).not.toHaveBeenCalled();

    advanceTo(40.1);
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  test("解除するとそれ以降呼ばれない", () => {
    const { video, advanceTo } = makeVideoWithFrames();
    const onReach = vi.fn();
    const cancel = onReachTime(video, 40, onReach);

    cancel();
    advanceTo(50);

    expect(onReach).not.toHaveBeenCalled();
  });
});

describe("getVideoMeta", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    document.title = "";
  });

  test("見出しからタイトルを拾う", () => {
    document.body.innerHTML =
      '<h1 class="ytd-watch-metadata"><yt-formatted-string>動画の題名</yt-formatted-string></h1>';
    expect(getVideoMeta()).toEqual({
      videoId: "abc123",
      title: "動画の題名",
      // チャンネルの手がかりが無いページ。タグが引けないだけで本文は成立する
      channelId: "",
      channelName: "",
    });
  });

  test("先頭の候補が空なら次の候補へ進む", () => {
    // 要素に一致するだけでは足りない。実機に、一致はするが中身が空になる
    // 画面構成があり、本文からタイトルだけが消えた
    document.body.innerHTML =
      '<h1 class="ytd-watch-metadata"><yt-formatted-string></yt-formatted-string></h1>' +
      '<div id="title"><h1><yt-formatted-string>本当の題名</yt-formatted-string></h1></div>';
    expect(getVideoMeta().title).toBe("本当の題名");
  });

  test("meta 要素からも拾える", () => {
    document.head.innerHTML = '<meta itemprop="name" content="メタの題名">';
    expect(getVideoMeta().title).toBe("メタの題名");
  });

  test("見出しが無ければタブのタイトルから復元する", () => {
    document.title = "タブの題名 - YouTube";
    expect(getVideoMeta().title).toBe("タブの題名");
  });

  test("タブのタイトルの未読件数を落とす", () => {
    document.title = "(12) タブの題名 - YouTube";
    expect(getVideoMeta().title).toBe("タブの題名");
  });

  test("どこからも取れなければ握り潰さず throw する", () => {
    // 空のまま進むと、本文が改行だけで始まる不可解な形になる
    document.title = "";
    expect(() => getVideoMeta()).toThrow(ElementNotFoundError);
  });
});

describe("getChannel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("ハンドルが取れなければ meta の UC を使う", () => {
    document.body.innerHTML = '<meta itemprop="channelId" content="UCabc123">';

    expect(getChannel().id).toBe("UCabc123");
  });

  test("構造化データから拾う", () => {
    // 実機の watch ページはこの形。見た目のレイアウトより変わりにくい
    document.body.innerHTML =
      '<span itemprop="author">' +
      '<link itemprop="url" href="https://www.youtube.com/@jawed">' +
      '<link itemprop="name" content="jawed">' +
      "</span>";

    expect(getChannel()).toEqual({ id: "@jawed", name: "jawed" });
  });

  test("相対 URL でも絶対 URL でも同じ鍵になる", () => {
    // 属性はページによってどちらでも来る。href プロパティで絶対に揃える
    document.body.innerHTML =
      '<div id="owner"><a href="/@foo">チャンネル A</a></div>';
    const relative = getChannel().id;

    document.body.innerHTML =
      '<div id="owner"><a href="https://www.youtube.com/@foo">チャンネル A</a></div>';

    expect(getChannel().id).toBe(relative);
    expect(relative).toBe("@foo");
  });

  test("UC のリンクが先にあってもハンドルを優先する", () => {
    // メンバーシップのあるチャンネルだけ /channel/UC.../join が出る、
    // といった差が実際にありうる。UC を優先すると、同じチャンネルなのに
    // 動画によって鍵が変わり、設定したタグが別の動画で出てこなくなる
    document.body.innerHTML =
      '<meta itemprop="channelId" content="UCreal">' +
      '<div id="owner"><ytd-channel-name><a href="/@foo">チャンネル A</a>' +
      "</ytd-channel-name></div>";

    expect(getChannel().id).toBe("@foo");
  });

  test("中身が空の候補は読み飛ばす", () => {
    document.body.innerHTML =
      '<meta itemprop="channelId" content="">' +
      '<div id="owner"><a href="/@foo">チャンネル A</a></div>';

    expect(getChannel().id).toBe("@foo");
  });

  test("ID が取れなければハンドルを鍵にする", () => {
    document.body.innerHTML =
      '<div id="owner"><ytd-channel-name><a href="/@foo.bar">チャンネル A</a>' +
      "</ytd-channel-name></div>";

    expect(getChannel()).toEqual({ id: "@foo.bar", name: "チャンネル A" });
  });

  test("どちらも取れなければ空文字を返す。throw はしない", () => {
    // タイトルと違い、チャンネルが分からなくても投稿本文は成立する。
    // ここで止めると、画面構成が少し変わっただけで録画ができなくなる
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(getChannel()).toEqual({ id: "", name: "" });
    // 握り潰さず理由は残す
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test("特定できなかったときは集まった候補もログに出す", () => {
    // 「特定できません」だけでは、次に何を直せばよいか分からない
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    document.body.innerHTML =
      '<div id="owner"><a href="/results">関係ないリンク</a></div>';

    getChannel();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/results"));
    warn.mockRestore();
  });

  test("名前が取れなくても ID があれば設定は引ける", () => {
    document.body.innerHTML = '<meta itemprop="channelId" content="UCabc123">';

    expect(getChannel()).toEqual({ id: "UCabc123", name: "UCabc123" });
  });
});
