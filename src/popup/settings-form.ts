import {
  SETTINGS_FIELDS,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsContext,
  type SettingsField,
} from "@/shared/settings";

/**
 * popup に常に出ている設定のフォーム (`.claude/specs/2026-10-04-settings-in-popup-design.md`)。
 * 前はバーの ⚙ で開く設定の窓に入っていた。
 *
 * **項目ごとの分岐を持たない。** `SETTINGS_FIELDS` を並べるだけにしてあるので、
 * 設定を足すときはそちらに 1 要素足せばここに出る。
 */
export type SettingsForm = {
  element: HTMLElement;
  /**
   * 保存済みの値と文脈を読み、入力欄へ流し込む。popup を開いたときに 1 回呼ぶ。
   * **読み終えるまで「保存」は押せない** (空の入力欄のまま保存すると、既定値で上書きする)
   */
  fill(): Promise<void>;
};

export type FormDeps = {
  load(): Promise<Settings>;
  save(patch: Partial<Settings>): Promise<void>;
  /**
   * いま開いているタブの動画の文脈。**fill のたびに読み、保存はそのとき読んだ文脈で行う**
   * (popup を開いている間はタブを移れないので、開くたびに読めば足りる。spec §2)
   */
  getContext(): Promise<SettingsContext>;
  /**
   * 書き込みが済んだ (popup はここで閉じる。spec §1)。**通らない項目があったとき・書けなかったときは呼ばない**
   * (閉じずに理由を見せ、直してもう一度押せるようにする)
   */
  onSaved(): void;
};

const defaultDeps: FormDeps = {
  load: loadSettings,
  save: saveSettings,
  getContext: () => Promise.resolve({ channel: null }),
  onSaved: () => undefined,
};

/**
 * popup の中の見た目。**popup の高さの上限 (Chrome は 600px) に収まるよう詰める**: 項目名と入力欄を横に並べ、
 * 説明は入力欄の下に小さく出す。配色は --ytc-* (popup.ts が body に置く。ページ内の窓と同じ配色)
 */
const FORM_STYLE = {
  root: "display:flex;flex-direction:column;gap:6px;",
  field: "display:grid;grid-template-columns:132px minmax(0,1fr);column-gap:8px;row-gap:2px;align-items:center;",
  label: "color:var(--ytc-text);font-size:12px;font-weight:500;",
  input:
    "appearance:none;box-sizing:border-box;width:100%;border:1px solid var(--ytc-border);border-radius:6px;height:26px;padding:0 8px;font:inherit;font-size:13px;background:transparent;color:var(--ytc-text);",
  /** 色の入力欄は見本だけ。幅いっぱいに伸ばさない */
  color:
    "box-sizing:border-box;width:44px;height:26px;padding:2px;border:1px solid var(--ytc-border);border-radius:6px;background:transparent;",
  hint: "grid-column:1/-1;color:var(--ytc-text-sub);font-size:11px;line-height:1.4;",
  /**
   * 「保存」は popup の下端に貼り付ける (sticky)。状態の文言が長いなどで popup の上限を超えてスクロールしても、
   * 押す場所を探させない
   */
  footer:
    "position:sticky;bottom:0;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:6px 0;background:var(--ytc-panel);",
  result: "color:var(--ytc-text-sub);font-size:12px;",
  save: "appearance:none;border:none;border-radius:14px;height:28px;padding:0 16px;font:inherit;font-weight:500;cursor:pointer;background:var(--ytc-accent);color:var(--ytc-on-accent);",
} as const;

/** 入力欄として振る舞う要素。`value` と `disabled` はどちらも持つ */
export type FieldInput = HTMLInputElement | HTMLSelectElement;

/**
 * 項目 1 つ分の入力欄を作る。
 *
 * **分岐するのは `control` だけ。** `key` を見て分岐すると、項目を足すたびに
 * ここへ戻ってくることになる (`scope` による分岐が `fill` に 1 箇所あるのと
 * 同じで、field 側が宣言した値しか見ない)
 */
export function createFieldInput(field: SettingsField): FieldInput {
  const id = `yt-clip-setting-${field.key}`;

  if (field.control.kind === "select") {
    const select = document.createElement("select");
    select.id = id;
    select.style.cssText = FORM_STYLE.input;
    select.append(
      ...field.control.options.map((option) => {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        return element;
      }),
    );
    return select;
  }

  const input = document.createElement("input");
  input.id = id;
  input.type = field.control.kind === "color" ? "color" : "text";
  input.style.cssText = field.control.kind === "color" ? FORM_STYLE.color : FORM_STYLE.input;
  if (field.control.kind === "text" && field.control.suggestions !== undefined) {
    // 候補の箱は `createFieldExtras` が作る。id の決め方をここと揃える
    input.setAttribute("list", `${id}-suggestions`);
  }
  return input;
}

/**
 * 入力欄の隣に置く要素。いまは候補の `datalist` だけ。
 *
 * **`createFieldInput` の返り値を変えない。** 入力欄として振る舞う要素を 1 つ返す
 * 形はテストと保存処理が前提にしている。候補の箱は DOM に置かないと効かないので、
 * パネルが入力欄と並べて置く
 */
export function createFieldExtras(field: SettingsField): HTMLElement[] {
  if (field.control.kind !== "text" || field.control.suggestions === undefined) {
    return [];
  }
  const datalist = document.createElement("datalist");
  datalist.id = `yt-clip-setting-${field.key}-suggestions`;
  datalist.append(
    ...field.control.suggestions.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
  return [datalist];
}

export function createSettingsForm(
  overrides: Partial<FormDeps> = {},
): SettingsForm {
  const deps: FormDeps = { ...defaultDeps, ...overrides };
  const element = document.createElement("div");
  element.style.cssText = FORM_STYLE.root;

  // 項目・入力欄・説明を組で持つ。鍵で引き直す形にすると、必ず存在するものに
  // 対して undefined チェックが要るうえ、項目が増えるたびに Map が 1 本増える
  const rows = SETTINGS_FIELDS.map((field) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = FORM_STYLE.field;

    const label = document.createElement("label");
    label.style.cssText = FORM_STYLE.label;
    label.textContent = field.label;
    label.htmlFor = `yt-clip-setting-${field.key}`;

    const input = createFieldInput(field);

    // 文言は文脈で変わる (どのチャンネルのタグか)。中身は fill で入れる
    const hint = document.createElement("div");
    hint.style.cssText = FORM_STYLE.hint;

    wrapper.append(label, input, ...createFieldExtras(field), hint);
    element.append(wrapper);
    return { field, input, hint };
  });

  const result = document.createElement("span");
  result.style.cssText = FORM_STYLE.result;

  const save = document.createElement("button");
  save.textContent = "保存";
  save.dataset.role = "save";
  save.style.cssText = FORM_STYLE.save;
  // 読み終えるまで押させない (fill)
  save.disabled = true;

  const footer = document.createElement("div");
  footer.style.cssText = FORM_STYLE.footer;
  footer.append(result, save);
  element.append(footer);

  /** fill で読んだ文脈。保存はこれで行う。読む前は null */
  let context: SettingsContext | null = null;

  /** 読んだ設定と文脈を入力欄へ流し込む */
  function render(settings: Settings, current: SettingsContext): void {
    for (const { field, input, hint } of rows) {
      // **分岐するのは scope だけ。** key を見て分岐すると、項目を足すたびに
      // ここへ戻ってくることになる
      const unavailable = field.scope === "channel" && current.channel === null;
      input.disabled = unavailable;
      input.value = unavailable ? "" : field.toText(settings, current);
      hint.textContent = field.hint(current);
    }
  }

  save.addEventListener("click", () => {
    // fill の前は disabled なので来ない。来たら配線のバグなので、黙って既定値を書く形で隠さない
    if (context === null) throw new Error("設定を読む前に保存が押されました");
    const current = context;
    void (async () => {
      try {
        // 差分の土台は**保存されている現在の設定**。チャンネル別の項目は
        // 他のチャンネル分を残したまま 1 件だけ差し替える必要がある
        const settings = await deps.load();

        // 項目ごとの差分をまとめて 1 回で書く
        let patch: Partial<Settings> = {};
        for (const { field, input } of rows) {
          // 入力させていない項目は保存の対象にしない。空のまま送ると、
          // チャンネルを特定できない画面を開いただけでタグが消える
          if (input.disabled) continue;

          const converted = field.fromText(input.value, settings, current);
          // **1 つでも通らなければ何も保存しない。** 一部だけ書き込むと、
          // エラーを見た利用者が「何が保存されて何が保存されなかったか」を
          // 画面から判断できない
          if (!converted.ok) {
            result.textContent = `${field.label}: ${converted.message}`;
            return;
          }
          patch = { ...patch, ...converted.patch };
        }
        await deps.save(patch);
        // 正規化した結果を出す。何が保存されたかを見せる。
        // 読んだばかりのものを渡して、storage の往復を省く
        render({ ...settings, ...patch }, current);
        result.textContent = "保存しました";
      } catch (error) {
        // 保存できていないのに黙っていると、設定したつもりで投稿してしまう
        result.textContent = `保存できませんでした: ${String(error)}`;
        return;
      }
      // 書き込みが済んでから知らせる (popup は閉じると処理ごと止まる)。try の外に置く: 受け手の失敗を
      // 「保存できませんでした」と取り違えない
      deps.onSaved();
    })();
  });

  return {
    element,
    async fill(): Promise<void> {
      save.disabled = true;
      result.textContent = "";
      try {
        const [settings, loaded] = await Promise.all([deps.load(), deps.getContext()]);
        context = loaded;
        render(settings, loaded);
        save.disabled = false;
      } catch (error) {
        // 読めないまま保存させると、空の入力欄で上書きする。押させずに理由を出す
        result.textContent = `設定を読めませんでした: ${String(error)}`;
      }
    },
  };
}
