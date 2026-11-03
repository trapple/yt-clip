// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Message } from "@/shared/messages";
import {
  SelectorMissingError,
  attachFile,
  attachPayload,
  buildClipFile,
  insertText,
  readBlocks,
  findElement,
  waitForElement,
} from "@/content/x";

describe("findElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("候補のうち最初に見つかったものを返す", () => {
    document.body.innerHTML = '<div id="second"></div>';
    expect(findElement(["#first", "#second"]).id).toBe("second");
  });

  test("先頭の候補を優先する", () => {
    document.body.innerHTML = '<div id="first"></div><div id="second"></div>';
    expect(findElement(["#first", "#second"]).id).toBe("first");
  });

  test("どれも見つからなければ握り潰さず throw する", () => {
    expect(() => findElement(["#none"])).toThrow(SelectorMissingError);
  });
});

describe("waitForElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("既に存在すれば即座に解決する", async () => {
    document.body.innerHTML = '<div id="target"></div>';
    await expect(waitForElement(["#target"])).resolves.toHaveProperty(
      "id",
      "target",
    );
  });

  test("後から現れた要素を拾う", async () => {
    const promise = waitForElement(["#late"]);
    const late = document.createElement("div");
    late.id = "late";
    document.body.appendChild(late);

    await expect(promise).resolves.toBe(late);
  });

  test("現れなければタイムアウトで reject する", async () => {
    vi.useFakeTimers();
    const promise = waitForElement(["#never"], 10000);
    const assertion = expect(promise).rejects.toThrow(SelectorMissingError);
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("attachFile", () => {
  test("DataTransfer 経由でファイルを載せ change を発火する", () => {
    const input = document.createElement("input");
    input.type = "file";
    // jsdom の input.files は書き込めないためテスト用に差し替える
    let assigned: FileList | null = null;
    Object.defineProperty(input, "files", {
      get: () => assigned,
      set: (value: FileList) => {
        assigned = value;
      },
      configurable: true,
    });

    const file = new File(["データ"], "clip.mp4", { type: "video/mp4" });
    const added: File[] = [];
    const fakeFiles = [file] as unknown as FileList;
    const createDataTransfer = () =>
      ({
        items: {
          add: (f: File) => {
            added.push(f);
          },
        },
        files: fakeFiles,
      }) as unknown as DataTransfer;

    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    attachFile(input, file, createDataTransfer);

    expect(added).toEqual([file]);
    expect(assigned).toBe(fakeFiles);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("change イベントは bubbles する", () => {
    const wrapper = document.createElement("div");
    const input = document.createElement("input");
    input.type = "file";
    Object.defineProperty(input, "files", {
      set: () => {},
      configurable: true,
    });
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);

    const onChange = vi.fn();
    wrapper.addEventListener("change", onChange);

    const file = new File(["データ"], "clip.mp4", { type: "video/mp4" });
    attachFile(
      input,
      file,
      () =>
        ({
          items: { add: () => {} },
          files: [file] as unknown as FileList,
        }) as unknown as DataTransfer,
    );

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("buildClipFile", () => {
  const payload = {
    base64: "AAECAw==",
    fileName: "clip.mp4",
    mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  };

  test("File のラベルにコーデック指定を残さない", () => {
    // 実機で X が「一部の画像/動画をアップロードできません。」を出した原因。
    // 中身は正しい MP4 なのに、ラベルにパラメータが残ると弾かれる
    expect(buildClipFile(payload).type).toBe("video/mp4");
  });

  test("素の MIME が渡ってきたらそのまま使う", () => {
    expect(buildClipFile({ ...payload, mimeType: "video/mp4" }).type).toBe(
      "video/mp4",
    );
  });

  test("ファイル名と中身はそのまま渡す", () => {
    const file = buildClipFile(payload);
    expect(file.name).toBe("clip.mp4");
    expect(file.size).toBe(4);
  });
});

describe("attachPayload", () => {
  const payload = {
    base64: "AAECAw==",
    fileName: "yt-clip-abc123-10s.mp4",
    mimeType: "video/mp4",
    text: "動画の題名\n\nhttps://youtu.be/abc123?t=10",
  };

  /**
   * 投稿画面を模す。**paste を受けてブロックを作る**ところだけ Draft.js に
   * 似せる。本物の Draft.js での検証は e2e が持つ (jsdom には Draft.js が無い)
   */
  function buildComposePage(draft: string): HTMLElement {
    document.body.innerHTML =
      '<div data-testid="tweetTextarea_0"></div>' +
      '<input data-testid="fileInput" type="file">';
    const editor = document.querySelector<HTMLElement>(
      '[data-testid="tweetTextarea_0"]',
    );
    if (editor === null) throw new Error("入力欄を作れませんでした");

    const render = (text: string): void => {
      editor.replaceChildren(
        ...text.split("\n").map((line) => {
          const block = document.createElement("div");
          block.dataset.block = "true";
          block.textContent = line;
          return block;
        }),
      );
    };
    render(draft);

    // Draft.js は paste を自前で処理し、選択範囲を差し替える。
    // ここでは常に全選択されている前提で、まるごと置き換える
    editor.addEventListener("paste", (event) => {
      const text = (event as ClipboardEvent).clipboardData?.getData(
        "text/plain",
      );
      if (text !== undefined) render(text);
    });
    return editor;
  }

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: () => Promise.resolve() },
    });

    // jsdom の input.files は読み取り専用で、代入すると strict mode で投げる
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get(): FileList | null {
        return (this as { __files?: FileList }).__files ?? null;
      },
      set(value: FileList) {
        (this as { __files?: FileList }).__files = value;
      },
    });

    // jsdom は ClipboardEvent を持たない。paste に載せる分だけ用意する
    vi.stubGlobal(
      "ClipboardEvent",
      class extends Event {
        readonly clipboardData: DataTransfer | null;
        constructor(type: string, init?: { clipboardData?: DataTransfer } & EventInit) {
          super(type, init);
          this.clipboardData = init?.clipboardData ?? null;
        }
      },
    );

    // jsdom は DataTransfer を持たない。使う分だけ用意する
    vi.stubGlobal(
      "DataTransfer",
      class {
        private readonly list: File[] = [];
        private readonly data = new Map<string, string>();
        readonly items = {
          add: (file: File): void => void this.list.push(file),
        };
        setData(type: string, value: string): void {
          this.data.set(type, value);
        }
        getData(type: string): string {
          return this.data.get(type) ?? "";
        }
        get files(): FileList {
          const list = this.list;
          return {
            ...list,
            length: list.length,
            item: (index: number) => list[index] ?? null,
          } as unknown as FileList;
        }
      },
    );
  });

  test("前の下書きを上書きする", async () => {
    // X は前回の下書きを復元する。残したまま入れると本文が二重になる
    const editor = buildComposePage("https://youtu.be/abc123?t=10");

    await attachPayload(payload);

    expect(readBlocks(editor)).toBe(payload.text);
  });

  test("execCommand を使わない", () => {
    // Draft.js に対して execCommand は壊れた入り方をする。画面には入って
    // 見えるのにモデルには一部しか入らず、X が投稿するのはモデル側。
    // 実装から消えたことを、ここで固定する
    const source = insertText.toString() + readBlocks.toString();
    expect(source).not.toContain("execCommand");
  });

  test("本文を入れてからファイルを添付する", async () => {
    // 添付すると X が UI を作り直すため、順番が逆だと焦点が定まらない。
    // jsdom では input.files を差し替えられないので、添付を知らせる change が
    // 飛んだ時点で本文が入っているかを見る
    const editor = buildComposePage("");
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="fileInput"]',
    );
    let textAtAttach: string | null = null;
    input?.addEventListener("change", () => {
      textAtAttach = readBlocks(editor);
    });

    await attachPayload(payload);

    expect(textAtAttach).toBe(payload.text);
    expect(input?.files?.[0]?.name).toBe("yt-clip-abc123-10s.mp4");
    expect(input?.files?.[0]?.type).toBe("video/mp4");
  });

  test("二度呼んでも積み上がらない", async () => {
    const editor = buildComposePage("");

    await attachPayload(payload);
    await attachPayload(payload);

    expect(readBlocks(editor)).toBe(payload.text);
  });

  describe("オン / オフ (start / stop。マスタースイッチの spec §5)", () => {
    type RuntimeListener = (
      message: Message,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => void;
    let runtimeListeners: RuntimeListener[] = [];
    let sendMessage = vi.fn(async (_message: Message) => undefined);

    /**
     * chrome を stub してから x.ts を読み直す (vitest はモジュールを覚えているので resetModules で捨てる)。
     * 保存されたオン / オフは enabled
     */
    async function loadX(enabled: boolean): Promise<typeof import("@/content/x")> {
      runtimeListeners = [];
      sendMessage = vi.fn(async (_message: Message) => undefined);
      vi.stubGlobal("chrome", {
        runtime: {
          sendMessage,
          onMessage: {
            addListener: (fn: RuntimeListener): void => {
              runtimeListeners.push(fn);
            },
            removeListener: (fn: RuntimeListener): void => {
              runtimeListeners = runtimeListeners.filter((listener) => listener !== fn);
            },
          },
        },
        storage: {
          local: { get: async (): Promise<Record<string, unknown>> => ({ enabled }) },
          onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
        },
      });
      vi.resetModules();
      return import("@/content/x");
    }

    async function flushTimers(): Promise<void> {
      for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    beforeEach(() => {
      history.pushState({}, "", "/compose/post");
    });

    afterEach(() => {
      history.pushState({}, "", "/");
    });

    test("オフのまま読み込むと x/ready を送らず、listener も張らない (import 時には何もしない)", async () => {
      await loadX(false);
      await flushTimers();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(runtimeListeners).toHaveLength(0);
    });

    test("オンで読み込むと、/compose/ なら x/ready を送り listener を張る", async () => {
      await loadX(true);
      await flushTimers();
      expect(sendMessage).toHaveBeenCalledWith({ type: "x/ready" });
      expect(runtimeListeners).toHaveLength(1);
    });

    test("start は /compose/ でなければ x/ready を送らない", async () => {
      const x = await loadX(false);
      await flushTimers();
      history.pushState({}, "", "/home");
      x.start();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(runtimeListeners).toHaveLength(1);
      x.stop();
    });

    test("stop で listener が外れ、外し損ねた listener に x/payload が届いても何もしない", async () => {
      const x = await loadX(false);
      await flushTimers();
      x.start();
      const listener = runtimeListeners[0];
      x.stop();
      expect(runtimeListeners).toHaveLength(0);

      const editor = buildComposePage("");
      const respond = vi.fn();
      listener?.({ type: "x/payload", ...payload }, {}, respond);
      await flushTimers();
      expect(respond).not.toHaveBeenCalled();
      expect(readBlocks(editor)).toBe("");
    });

    test("進行中の attachPayload は stop 後も完了して x/attached を送る (半端な本文を残さない)", async () => {
      const x = await loadX(false);
      await flushTimers();
      x.start();
      sendMessage.mockClear();
      const editor = buildComposePage("");

      runtimeListeners[0]?.({ type: "x/payload", ...payload }, {}, () => undefined);
      x.stop();

      await vi.waitFor(
        () => expect(sendMessage).toHaveBeenCalledWith({ type: "x/attached" }),
        { timeout: 5_000 },
      );
      expect(readBlocks(editor)).toBe(payload.text);
    });

    test("start を二度呼ぶ・走っていないのに stop を呼ぶのは配線の誤りなので throw", async () => {
      const x = await loadX(false);
      await flushTimers();
      expect(() => x.stop()).toThrow("走っていない");
      x.start();
      expect(() => x.start()).toThrow("二度");
      x.stop();
    });
  });
});

describe("readBlocks", () => {
  test("ブロックを改行で繋ぐ", () => {
    // **textContent を見てはいけない。** 壊れた入り方をしたときに残る
    // 幽霊 DOM が混ざり、入っていないものが入って見える
    const editor = document.createElement("div");
    editor.innerHTML =
      '<div data-block="true">一行目</div><div data-block="true">二行目</div>' +
      "<div>幽霊</div>";

    expect(readBlocks(editor)).toBe("一行目\n二行目");
  });

  test("ブロックが無ければ空", () => {
    const editor = document.createElement("div");
    editor.textContent = "まだ描き直されていない";
    expect(readBlocks(editor)).toBe("");
  });
});
