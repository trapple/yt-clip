// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  SelectorMissingError,
  attachFile,
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
