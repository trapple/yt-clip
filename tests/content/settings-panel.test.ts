// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { CHANNEL } from "../helpers/fixtures";
import { createFieldInput, createSettingsPanel } from "@/content/settings-panel";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  type Settings,
  type SettingsContext,
  type SettingsField,
} from "@/shared/settings";


function makeDeps(
  initial: Partial<Settings> = {},
  context: SettingsContext = { channel: CHANNEL },
) {
  const store: Settings = { ...DEFAULT_SETTINGS, ...initial };
  const saved: Partial<Settings>[] = [];
  return {
    store,
    saved,
    deps: {
      load: () => Promise.resolve({ ...store }),
      save: (patch: Partial<Settings>) => {
        saved.push(patch);
        Object.assign(store, patch);
        return Promise.resolve();
      },
      getContext: () => context,
    },
  };
}

function inputOf(panel: { element: HTMLElement }, key: string): HTMLInputElement {
  const input = panel.element.querySelector<HTMLInputElement>(
    `#yt-clip-setting-${key}`,
  );
  if (input === null) throw new Error(`入力欄がありません: ${key}`);
  return input;
}

function saveButton(panel: { element: HTMLElement }): HTMLButtonElement {
  const button = panel.element.querySelector<HTMLButtonElement>(
    "[data-role=save]",
  );
  if (button === null) throw new Error("保存ボタンがありません");
  return button;
}

/** click の中の非同期処理を流す */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("createSettingsPanel", () => {
  test("項目定義の数だけ入力欄が出る", () => {
    // 設定を足すときに触るのは SETTINGS_FIELDS だけ、という約束を固定する
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);

    // select の項目もあるので input だけを数えない
    expect(panel.element.querySelectorAll("input, select")).toHaveLength(
      SETTINGS_FIELDS.length,
    );
  });

  test("最初は閉じている", () => {
    const { deps } = makeDeps();
    expect(createSettingsPanel(deps).element.hidden).toBe(true);
  });

  test("開くと保存済みの値が入る", async () => {
    const { deps } = makeDeps({
      hashtagsByChannel: { [CHANNEL.id]: ["切り抜き", "VTuber"] },
    });
    const panel = createSettingsPanel(deps);

    panel.toggle();
    await flush();

    expect(panel.element.hidden).toBe(false);
    expect(inputOf(panel, "hashtags").value).toBe("#切り抜き #VTuber");
  });

  test("もう一度押すと閉じる", () => {
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);

    panel.toggle();
    panel.toggle();

    expect(panel.element.hidden).toBe(true);
  });

  test("閉じている間は inline の display も none にする", () => {
    // 根は display:flex を inline で持つので、hidden だけだと UA の [hidden] に勝って出たままになる。
    // jsdom は UA の [hidden] を計算しないので style.display で測る
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    expect(panel.element.style.display).toBe("none");

    panel.toggle();
    expect(panel.element.style.display).toBe("flex");

    panel.toggle();
    expect(panel.element.style.display).toBe("none");
  });

  test("保存すると正規化された値が書き込まれる", async () => {
    const { saved, deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await flush();

    inputOf(panel, "hashtags").value = "切り抜き #VTuber、切り抜き";
    saveButton(panel).click();
    await flush();

    // 保存は 1 回。すべての項目の差分がまとめて 1 つの patch に入る
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      hashtagsByChannel: { [CHANNEL.id]: ["切り抜き", "VTuber"] },
    });
  });

  test("保存した後は正規化された形が入力欄に出る", async () => {
    // 何が保存されたかを見せる。# の有無や重複がどう扱われたか分かる
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await flush();

    inputOf(panel, "hashtags").value = "切り抜き 切り抜き";
    saveButton(panel).click();
    await flush();

    expect(inputOf(panel, "hashtags").value).toBe("#切り抜き");
  });

  test("開き直すと読み直す", async () => {
    // 別のタブで変えた設定を、古い値で上書きしないため
    const { store, deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await flush();

    panel.toggle();
    store.hashtagsByChannel = { [CHANNEL.id]: ["あとで変えた"] };
    panel.toggle();
    await flush();

    expect(inputOf(panel, "hashtags").value).toBe("#あとで変えた");
  });

  test("保存できなければ黙らずに伝える", async () => {
    // 保存できていないのに黙っていると、設定したつもりで投稿してしまう
    const panel = createSettingsPanel({
      load: () => Promise.resolve(DEFAULT_SETTINGS),
      save: () => Promise.reject(new Error("書き込めません")),
    });
    panel.toggle();
    await flush();

    saveButton(panel).click();
    await flush();

    expect(panel.element.textContent).toContain("保存できませんでした");
  });
});

describe("入力を受け付けないとき", () => {
  test("理由を出して保存しない", async () => {
    // 保存できなかったことを黙ると、設定したつもりで録画に進んでしまう
    const { deps, saved } = makeDeps();
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);
    panel.toggle();
    await flush();

    inputOf(panel, "maxClipSec").value = "999";
    saveButton(panel).click();
    await flush();

    expect(saved).toEqual([]);
    expect(panel.element.textContent).toContain("最大秒数");
  });

  test("1 つでも通らなければ他の項目も保存しない", async () => {
    // 一部だけ書き込むと、何が保存されて何が保存されなかったかを
    // 画面から判断できない
    const { deps, saved } = makeDeps();
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);
    panel.toggle();
    await flush();

    inputOf(panel, "hashtags").value = "切り抜き";
    inputOf(panel, "maxClipSec").value = "abc";
    saveButton(panel).click();
    await flush();

    expect(saved).toEqual([]);
  });

  test("直して押し直せば保存できる", async () => {
    const { deps, saved } = makeDeps();
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);
    panel.toggle();
    await flush();

    inputOf(panel, "maxClipSec").value = "999";
    saveButton(panel).click();
    await flush();
    inputOf(panel, "maxClipSec").value = "30";
    saveButton(panel).click();
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ maxClipSec: 30 });
    expect(panel.element.textContent).toContain("保存しました");
  });
});

describe("チャンネルを特定できない画面", () => {
  test("チャンネル別の項目は入力させない", async () => {
    const { deps } = makeDeps(
      { hashtagsByChannel: { [CHANNEL.id]: ["切り抜き"] } },
      { channel: null },
    );
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);

    panel.toggle();
    await flush();

    expect(inputOf(panel, "hashtags").disabled).toBe(true);
    // 理由を出す。無効なだけだと壊れているように見える
    expect(panel.element.textContent).toContain("特定できない");
  });

  test("チャンネルに依らない項目は入力できる", async () => {
    const { deps } = makeDeps({}, { channel: null });
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);

    panel.toggle();
    await flush();

    expect(inputOf(panel, "maxClipSec").disabled).toBe(false);
  });

  test("保存してもタグが消えない", async () => {
    // 入力させていない項目を空のまま送ると、開いただけでタグが消える
    const { deps, store } = makeDeps(
      { hashtagsByChannel: { [CHANNEL.id]: ["切り抜き"] } },
      { channel: null },
    );
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);
    panel.toggle();
    await flush();

    inputOf(panel, "maxClipSec").value = "30";
    saveButton(panel).click();
    await flush();

    expect(store.hashtagsByChannel).toEqual({ [CHANNEL.id]: ["切り抜き"] });
    expect(store.maxClipSec).toBe(30);
  });
});

describe("どのチャンネルの設定かを見せる", () => {
  test("説明にチャンネル名が出る", async () => {
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);

    panel.toggle();
    await flush();

    expect(panel.element.textContent).toContain(CHANNEL.name);
  });
});

describe("入力欄の種類", () => {
  test("text の項目は input として出る", () => {
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);

    expect(inputOf(panel, "maxClipSec").tagName).toBe("INPUT");
  });

  test("select の項目は option つきの select として出る", () => {
    // 実際の項目は別途足す。ここでは作り分けの枠組みだけを確かめる
    const field: SettingsField = {
      key: "dummy",
      label: "ダミー",
      scope: "global",
      control: {
        kind: "select",
        options: [
          { value: "a", label: "あ" },
          { value: "b", label: "い" },
        ],
      },
      hint: () => "",
      toText: () => "b",
      fromText: () => ({ ok: true, patch: {} }),
    };

    const element = createFieldInput(field);

    expect(element.tagName).toBe("SELECT");
    expect(element.id).toBe("yt-clip-setting-dummy");
    expect([...element.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "a",
      "b",
    ]);
    expect(
      [...element.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["あ", "い"]);
  });
});

describe("テロップの見た目", () => {
  test("色の項目は色の入力欄になる", () => {
    const field = SETTINGS_FIELDS.find((f) => f.key === "telopFillColor");
    if (field === undefined) throw new Error("項目がありません");
    const input = createFieldInput(field) as HTMLInputElement;
    expect(input.type).toBe("color");
  });

  test("フォントの項目は候補付きのテキスト欄になる", () => {
    const panel = createSettingsPanel(makeDeps().deps);
    const input = inputOf(panel, "telopFont");
    expect(input.type).toBe("text");
    const listId = input.getAttribute("list");
    expect(listId).not.toBeNull();
    const datalist = panel.element.querySelector(`#${listId ?? ""}`);
    const values = [...(datalist?.querySelectorAll("option") ?? [])].map(
      (option) => option.value,
    );
    expect(values).toEqual(["ゴシック", "明朝", "丸ゴシック"]);
  });

  test("テロップの 2 項目を同時に変えても両方が保存される", async () => {
    // 1 つのオブジェクトにまとめると、浅いマージで後の項目が前の項目を消す
    const { deps, store } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    inputOf(panel, "telopFontSizePx").value = "80";
    inputOf(panel, "telopStrokeColor").value = "#112233";
    saveButton(panel).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.telopFontSizePx).toBe(80);
    expect(store.telopStrokeColor).toBe("#112233");
  });
});
