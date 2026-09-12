// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  SelectorMissingError,
  attachFile,
  attachPayload,
  buildClipFile,
  containsHead,
  keepText,
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

describe("containsHead", () => {
  /** 本文テンプレートの既定値と同じ形。タイトル + 空行 + URL */
  const body = (title: string) => `${title}\n\nhttps://youtu.be/abc123?t=10`;

  test("入力された本文に先頭が現れていれば一致とみなす", () => {
    const text = body("とても長いタイトルの動画です");
    expect(containsHead(text, text)).toBe(true);
  });

  test("Draft.js が改行を落としても一致とみなす", () => {
    // Draft.js は改行をブロックの境目として表し、テキストノードには
    // 改行文字を置かない。改行を含んだまま比べると必ず一致しなくなる
    const text = body("短い");
    const asRendered = text.replace(/\n/g, "");
    expect(containsHead(asRendered, text)).toBe(true);
  });

  test("タイトルが 1 文字でも、改行のせいで失敗と判定しない", () => {
    // 先頭 20 文字に改行が入るのは、まさにタイトルが短いとき
    const text = body("あ");
    expect(containsHead(text.replace(/\n/g, ""), text)).toBe(true);
  });

  test("本文が入っていなければ一致しない", () => {
    expect(containsHead("", body("タイトル"))).toBe(false);
    expect(containsHead("別の本文が入っています", body("タイトル"))).toBe(
      false,
    );
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

describe("keepText", () => {
  const text = "動画の題名\n\nhttps://youtu.be/abc123?t=10";

  /** 待ち時間を消費しないので、テストは実時間を払わない */
  const noWait = async (): Promise<void> => undefined;

  /**
   * jsdom は execCommand を持たないので中身の変化を自分で再現する。
   * **本体は全選択してから入れるので、insertText は置き換えになる** (実物と同じ)
   */
  function stubInsert(editor: HTMLElement): ReturnType<typeof vi.fn> {
    const fn = vi.fn((command: string, _ui?: boolean, value?: string) => {
      if (command === "insertText") editor.textContent = String(value);
      return true;
    });
    (document as unknown as { execCommand: unknown }).execCommand = fn;
    return fn;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("本文が残っていれば何もしない", async () => {
    const editor = document.createElement("div");
    editor.textContent = text;
    const insert = stubInsert(editor);

    await keepText(text, () => editor, noWait);

    expect(insert).not.toHaveBeenCalled();
  });

  test("添付で消えた本文を入れ直す", async () => {
    // 動画は「準備完了」なのに本文だけ空、という形で実機に出た
    const editor = document.createElement("div");
    document.body.append(editor);
    const insert = stubInsert(editor);

    await keepText(text, () => editor, noWait);

    expect(editor.textContent).toBe(text);
    expect(insert).toHaveBeenCalled();
  });

  test("入力欄が見つからない周回は飛ばす", async () => {
    // 作り直しの最中は入力欄が居ないことがある。そこで諦めない
    const editor = document.createElement("div");
    document.body.append(editor);
    stubInsert(editor);
    let looks = 0;

    await keepText(
      text,
      () => {
        looks += 1;
        return looks <= 3 ? null : editor;
      },
      noWait,
    );

    expect(editor.textContent).toBe(text);
  });

  test("消されるたびに入れ直す", async () => {
    // 作り直しが一度だけとは限らない
    const editor = document.createElement("div");
    document.body.append(editor);
    const insert = stubInsert(editor);
    let wiped = 0;

    await keepText(
      text,
      () => {
        if (wiped < 2) {
          wiped += 1;
          editor.textContent = "";
        }
        return editor;
      },
      noWait,
    );

    expect(insert.mock.calls.filter(([c]) => c === "insertText")).toHaveLength(2);
    expect(editor.textContent).toBe(text);
  });
});

describe("attachPayload", () => {
  const payload = {
    base64: "AAECAw==",
    fileName: "yt-clip-abc123-10s.mp4",
    mimeType: "video/mp4",
    text: "動画の題名\n\nhttps://youtu.be/abc123?t=10",
  };

  function buildComposePage(draft: string): HTMLElement {
    document.body.innerHTML =
      '<div data-testid="tweetTextarea_0"></div>' +
      '<input data-testid="fileInput" type="file">';
    const editor = document.querySelector<HTMLElement>(
      '[data-testid="tweetTextarea_0"]',
    );
    if (editor === null) throw new Error("入力欄を作れませんでした");
    editor.textContent = draft;
    return editor;
  }

  beforeEach(() => {
    // jsdom は execCommand を持たない。実物と同じ「末尾に足す」形で再現する
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(
      (command: string, _ui?: boolean, value?: string) => {
        const editor = document.querySelector<HTMLElement>(
          '[data-testid="tweetTextarea_0"]',
        );
        if (editor === null) return false;
        // 本体は全選択してから入れるので、置き換えになる
        if (command === "insertText") editor.textContent = String(value);
        return true;
      },
    );
    vi.stubGlobal("chrome", { runtime: { sendMessage: () => Promise.resolve() } });

    // jsdom の input.files は読み取り専用で、代入すると strict mode で投げる。
    // 実物では差し替えられる場所なので、書き換えられるようにしておく
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get(): FileList | null {
        return (this as { __files?: FileList }).__files ?? null;
      },
      set(value: FileList) {
        (this as { __files?: FileList }).__files = value;
      },
    });

    // jsdom は DataTransfer を持たない。attachFile が使う分だけ用意する
    vi.stubGlobal(
      "DataTransfer",
      class {
        private readonly list: File[] = [];
        readonly items = { add: (file: File): void => void this.list.push(file) };
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
    // X は前回の下書きを復元する。そのまま入れると末尾に足されて
    // 本文が二重になる (実機で URL が 2 つ並んだ)
    const editor = buildComposePage("https://youtu.be/abc123?t=10");

    await attachPayload(payload);

    expect(editor.textContent).toBe(payload.text);
  });

  test("選択を残さず置き換えるので、入力欄が編集を受け付ける", async () => {
    // 消してから入れる (delete → insertText) と、Draft.js の内部状態と DOM が
    // ずれて編集できなくなる。実機で「入力した文字が編集できない」形で出た
    const editor = buildComposePage("前の下書き");
    const commands: string[] = [];
    (document as unknown as { execCommand: unknown }).execCommand = (
      command: string,
      _ui?: boolean,
      value?: string,
    ): boolean => {
      commands.push(command);
      if (command === "insertText") editor.textContent = String(value);
      return true;
    };

    await attachPayload(payload);

    expect(commands).toEqual(["insertText"]);
    expect(commands).not.toContain("delete");
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
      textAtAttach = editor.textContent;
    });

    await attachPayload(payload);

    expect(textAtAttach).toBe(payload.text);
    expect(input?.files?.[0]?.name).toBe("yt-clip-abc123-10s.mp4");
    expect(input?.files?.[0]?.type).toBe("video/mp4");
  });
});
