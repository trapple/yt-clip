/**
 * 設定。
 *
 * **`chrome.storage.sync` の `settings` キー 1 つに全部入れる。** キーを設定
 * ごとに散らすと、読み出しが増えるたびに `get` の呼び出しと既定値の補完を
 * 書き足すことになる。
 *
 * 設定を足すときに触るのは 2 箇所だけ: `Settings` に 1 行、
 * `SETTINGS_FIELDS` に 1 要素。それだけで画面にも出る。
 */

import {
  DEFAULT_MAX_CLIP_SEC,
  MAX_SETTABLE_CLIP_SEC,
  MIN_CLIP_SEC,
} from "@/shared/time";
import { TELOP_FONT_PRESETS } from "@/shared/telop-style";

export const SETTINGS_KEY = "settings";

/**
 * 切り抜きの作り方。
 *
 * **往復するトグルではなく設定にしてある。** 往復を許すと「シンプルで作った
 * 範囲をエディットに引き継ぐか」という問いが常に付きまとう。固定モードなら
 * 切り替えは稀な操作として扱える。
 */
export type ClipMode = "simple" | "edit";

export type Settings = {
  /** 投稿本文のテンプレート。いまは画面から編集できないが設定ではある */
  template: string;
  /**
   * チャンネルごとの、本文の末尾に付けるハッシュタグ。**`#` は含めない**
   *
   * 共通のタグは持たない。切り抜くチャンネルごとに付けるタグが違うため
   */
  hashtagsByChannel: Record<string, string[]>;
  /** 1 クリップの最大長 (秒) */
  maxClipSec: number;
  /** 切り抜きの作り方。エディットでは複数の区間を結合できる */
  mode: ClipMode;
  // テロップの見た目。**5 つの平坦なキーで持つ。** 1 つのオブジェクトにまとめると、
  // 設定パネルの保存 (項目ごとの差分を浅く重ねる) で後の項目が前の項目を消す
  /** テロップの文字の大きさ。動画の高さ 1080 px を基準にした px */
  telopFontSizePx: number;
  /** フォント。プリセットの表示名か、font-family に渡す名前 */
  telopFont: string;
  /** 文字の色 (#rrggbb) */
  telopFillColor: string;
  /** 縁取りの色 (#rrggbb) */
  telopStrokeColor: string;
  /** 縁取りの太さ。1080 px 基準。0 で縁取りなし */
  telopStrokeWidthPx: number;
};

/** チャンネル。`id` が設定の鍵、`name` は表示用 */
export type Channel = {
  id: string;
  name: string;
};

/** 設定を読み書きするときの文脈。チャンネル別の項目が要る */
export type SettingsContext = {
  /** いま開いている動画のチャンネル。特定できなければ null */
  channel: Channel | null;
};

/** 既定の投稿本文。`{tags}` は自分で区切りを持つ (下記 tagsVariable 参照) */
export const DEFAULT_TEMPLATE = "{title}\n\n{url}{tags}";

export const DEFAULT_SETTINGS: Settings = {
  template: DEFAULT_TEMPLATE,
  hashtagsByChannel: {},
  maxClipSec: DEFAULT_MAX_CLIP_SEC,
  mode: "simple",
  telopFontSizePx: 64,
  telopFont: TELOP_FONT_PRESETS[0].label,
  telopFillColor: "#ffffff",
  telopStrokeColor: "#000000",
  telopStrokeWidthPx: 8,
};

/** 区切りとして扱う文字。全角空白と読点も含める */
const SEPARATORS = /[\s,、]+/u;

/**
 * 入力欄の文字列をハッシュタグの配列にする。
 *
 * **保存する値に `#` は含めない。** 表示や本文の組み立てで付ける方が、
 * 二重に付く事故が起きない。同じタグが並んだら 1 つにまとめ、順序は入力のまま保つ
 */
export function normalizeHashtags(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const piece of input.split(SEPARATORS)) {
    // 先頭の # は何個付いていても落とす
    const tag = piece.replace(/^#+/u, "").trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** ハッシュタグを本文や入力欄に出す形にする */
export function formatHashtags(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

/**
 * テンプレートの `{tags}` に入る値。
 *
 * **自分で区切りを持つ。** テンプレート側に `\n\n{tags}` と書くと、タグが
 * 未設定のときに本文が空行 2 つで終わってしまう
 */
export function tagsVariable(tags: string[]): string {
  const formatted = formatHashtags(tags);
  return formatted === "" ? "" : `\n\n${formatted}`;
}

/**
 * 入力欄の文字列を最大秒数の差分にする。
 *
 * **通らない理由を返す。** 黙って既定値に倒すと、設定したつもりで録画に進む。
 * 結果の形は `FieldResult` に揃える。ここだけ別のユニオンにすると、
 * 呼び出し側が中身を取り出して包み直すだけの層ができる
 */
export function parseMaxClipSec(input: string): FieldResult {
  const text = input.trim();
  if (text === "") {
    return { ok: false, message: "最大秒数を入れてください" };
  }

  // Number("") が 0 になるのは上で弾いてある。ここでは形だけを見る
  const value = Number(text);
  if (!Number.isInteger(value)) {
    return { ok: false, message: `最大秒数は整数で入れてください: ${text}` };
  }
  if (!isSettableClipSec(value)) {
    return {
      ok: false,
      message: `最大秒数は ${MIN_CLIP_SEC}〜${MAX_SETTABLE_CLIP_SEC} 秒です: ${value}`,
    };
  }
  return { ok: true, patch: { maxClipSec: value } };
}

/**
 * 入力欄の文字列をモードの差分にする。
 *
 * **既定値に倒さない。** 選択肢しか出していないのに別の値が来たら、それは
 * UI のバグである。黙って `simple` にすると、エディットに切り替えたつもりで
 * シンプルのまま録画に進む
 */
export function parseMode(input: string): FieldResult {
  if (!isClipMode(input)) {
    return { ok: false, message: `知らないモードです: ${input}` };
  }
  return { ok: true, patch: { mode: input } };
}

/** テロップの文字の大きさとして設定できる範囲 (1080 px 基準) */
export const TELOP_FONT_SIZE_RANGE = { min: 16, max: 200 } as const;
/** 縁取りの太さとして設定できる範囲 (1080 px 基準) */
export const TELOP_STROKE_WIDTH_RANGE = { min: 0, max: 40 } as const;

/** 範囲内の整数か。読み込みと入力の両方で使う */
function isIntegerIn(
  value: unknown,
  range: { min: number; max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

/**
 * 整数の入力欄を差分にする。**範囲外は弾く。** 既定値に倒すのは読み込み側だけ
 * (`parseMaxClipSec` と同じ。設定したつもりで録画に進ませない)
 */
function parseIntegerField(
  input: string,
  label: string,
  range: { min: number; max: number },
  toPatch: (value: number) => Partial<Settings>,
): FieldResult {
  const text = input.trim();
  if (text === "") return { ok: false, message: `${label}を入れてください` };
  const value = Number(text);
  if (!isIntegerIn(value, range)) {
    return {
      ok: false,
      message: `${label}は ${range.min}〜${range.max} の整数です: ${text}`,
    };
  }
  return { ok: true, patch: toPatch(value) };
}

export function parseTelopFontSize(input: string): FieldResult {
  return parseIntegerField(input, "文字サイズ", TELOP_FONT_SIZE_RANGE, (value) => ({
    telopFontSizePx: value,
  }));
}

export function parseTelopStrokeWidth(input: string): FieldResult {
  return parseIntegerField(
    input,
    "縁取りの太さ",
    TELOP_STROKE_WIDTH_RANGE,
    (value) => ({ telopStrokeWidthPx: value }),
  );
}

/** font の指定を壊す文字。引用符が混ざると `ctx.font` への代入が黙って無視される */
const FONT_NAME_FORBIDDEN = /["'\\;]/u;

/** 保存されている値がフォント名として使えるか */
function isFontName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !FONT_NAME_FORBIDDEN.test(value)
  );
}

/**
 * フォントの入力欄を差分にする。
 *
 * **手元に無いフォントかは調べない。** `document.fonts.check()` はシステムフォントに
 * 常に真を返すので判定に使えない。代わりのフォントで描かれたことはプレビューで見える。
 * `,` は弾かない (ファミリの区切りとして読まれ、候補が 2 つになるだけ)
 */
export function parseTelopFont(input: string): FieldResult {
  const name = input.trim();
  if (name === "") return { ok: false, message: "フォントを入れてください" };
  if (!isFontName(name)) {
    return {
      ok: false,
      message: `フォント名に使えない文字が入っています (" ' \\ ;): ${name}`,
    };
  }
  return { ok: true, patch: { telopFont: name } };
}

/** `input type="color"` が返す形。これ以外は受け付けない */
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** 色の入力欄を差分にする。小文字に揃えて保存する */
export function parseColor(
  key: "telopFillColor" | "telopStrokeColor",
  input: string,
): FieldResult {
  const text = input.trim();
  if (!isHexColor(text)) {
    return { ok: false, message: `色は #rrggbb の形で入れてください: ${text}` };
  }
  return { ok: true, patch: { [key]: text.toLowerCase() } };
}

/**
 * そのチャンネルに付けるタグ。
 *
 * **`channelId` が欠けていることを許す。** IndexedDB に残っている古いクリップの
 * `meta` には `channelId` が無い。型の上では `string` だが、保存済みの値は
 * 型を保証しない。
 *
 * 設定がまだ無いチャンネルでは空を返す。**画面の表示と本文の組み立ては
 * 同じ関数から引くこと。** 別々に書くと「パネルには出ているのに本文に
 * 入らない」食い違いが生まれる
 */
export function hashtagsFor(
  settings: Settings,
  channelId: string | undefined,
): string[] {
  if (channelId === undefined || channelId === "") return [];
  return settings.hashtagsByChannel[channelId] ?? [];
}

/** 設定として受け入れられる最大長かどうか。読み込みと入力の両方で使う */
function isSettableClipSec(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CLIP_SEC &&
    value <= MAX_SETTABLE_CLIP_SEC
  );
}

/** 保存されている値がモードとして読めるか */
function isClipMode(value: unknown): value is ClipMode {
  return value === "simple" || value === "edit";
}

/** 保存されている値が期待する型かどうか */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** チャンネル ID → タグ の対応表として読めるか */
function isTagMap(value: unknown): value is Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isStringArray);
}

/**
 * 保存されている値を既定値の上に重ねる。
 *
 * **型は保証されない。** 古いバージョンが書いたものや、同期で他の端末から
 * 来たものでありうる。型の合う項目だけを採り、合わないものは既定値のまま
 * 使う。握り潰さず理由は残す
 */
export function mergeSettings(stored: unknown): Settings {
  if (stored === null || typeof stored !== "object") return DEFAULT_SETTINGS;

  const source = stored as Record<string, unknown>;
  const settings: Settings = { ...DEFAULT_SETTINGS };

  if (typeof source.template === "string" && source.template !== "") {
    settings.template = source.template;
  } else if (source.template !== undefined) {
    console.warn("[yt-clip] 保存された template が使えないため既定値を使います");
  }

  if (isTagMap(source.hashtagsByChannel)) {
    settings.hashtagsByChannel = source.hashtagsByChannel;
  } else if (source.hashtagsByChannel !== undefined) {
    console.warn(
      "[yt-clip] 保存された hashtagsByChannel が使えないため既定値を使います",
    );
  }

  // チャンネル別にする前の共通タグ。**引き継がない。**
  // どのチャンネルにも同じタグが出てくるのは邪魔で、「チャンネル別のみ」という
  // 決定とも食い違う。ただし**黙って消さない**。値ごと残す。
  // 保存し直せば、この古いキーは storage からも消える
  if (isStringArray(source.hashtags) && source.hashtags.length > 0) {
    console.info(
      `[yt-clip] 共通のハッシュタグ (${formatHashtags(source.hashtags)}) は使われなくなりました。必要なチャンネルで設定し直してください`,
    );
  }

  if (isSettableClipSec(source.maxClipSec)) {
    settings.maxClipSec = source.maxClipSec;
  } else if (source.maxClipSec !== undefined) {
    console.warn(
      `[yt-clip] 保存された maxClipSec が使えないため既定値を使います: ${String(source.maxClipSec)}`,
    );
  }

  if (isClipMode(source.mode)) {
    settings.mode = source.mode;
  } else if (source.mode !== undefined) {
    console.warn(
      `[yt-clip] 保存された mode が使えないため既定値を使います: ${String(source.mode)}`,
    );
  }

  // テロップの見た目。どれも同じ作法: 型の合う値だけ採り、合わなければ理由を残す
  const telopFields = [
    ["telopFontSizePx", (v: unknown) => isIntegerIn(v, TELOP_FONT_SIZE_RANGE)],
    ["telopFont", isFontName],
    ["telopFillColor", isHexColor],
    ["telopStrokeColor", isHexColor],
    ["telopStrokeWidthPx", (v: unknown) => isIntegerIn(v, TELOP_STROKE_WIDTH_RANGE)],
  ] as const;
  for (const [key, accepts] of telopFields) {
    const value = source[key];
    if (accepts(value)) {
      Object.assign(settings, {
        [key]: typeof value === "string" && key !== "telopFont" ? value.toLowerCase() : value,
      });
    } else if (value !== undefined) {
      console.warn(
        `[yt-clip] 保存された ${key} が使えないため既定値を使います: ${String(value)}`,
      );
    }
  }

  return settings;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

/** 一部だけ差し替える。他の項目は保存されているものを残す */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.sync.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

/**
 * 入力欄 1 つ分の変換結果。
 *
 * **通らない入力を黙って捨てない。** `RangeValidation` と同じ判別可能ユニオンで、
 * 通らなかった理由をそのまま画面に出せる形にする
 */
export type FieldResult =
  | { ok: true; patch: Partial<Settings> }
  | { ok: false; message: string };

/** 選択肢 1 つ分 */
export type SelectOption = { value: string; label: string };

/**
 * 入力欄の種類。
 *
 * **パネルはこれを見て作り分ける。`key` を見て分岐しない。** key で分岐すると、
 * 項目を足すたびにパネルへ戻ってくることになり、「触るのは `Settings` と
 * `SETTINGS_FIELDS` の 2 箇所だけ」という性質が崩れる。
 */
export type FieldControl =
  /** `suggestions` があれば候補として出す。候補以外も書ける */
  | { kind: "text"; suggestions?: readonly string[] }
  | { kind: "select"; options: readonly SelectOption[] }
  /** `#rrggbb` の文字列で往復する */
  | { kind: "color" };

export type SettingsField = {
  /** 入力欄を識別する。DOM の id にも使う */
  key: string;
  label: string;
  /**
   * チャンネルが必要な項目かどうか。
   * `channel` の項目は、チャンネルを特定できない画面では入力させない。
   * **パネルが分岐するのはここだけ。** `key` を見て分岐してはいけない
   */
  scope: "global" | "channel";
  /** 入力欄の種類。パネルはこれを見て作り分ける */
  control: FieldControl;
  /**
   * 入力欄の下に出す短い説明。
   * 「どのチャンネルのタグか」を出すので文脈を受け取る
   */
  hint(context: SettingsContext): string;
  /** 保存されている値を入力欄の文字列にする */
  toText(settings: Settings, context: SettingsContext): string;
  /**
   * 入力欄の文字列から、設定の一部を作る。
   *
   * **現在の設定を受け取る。** チャンネル別の項目は、他のチャンネル分を
   * 残したまま 1 件だけ差し替える必要がある
   */
  fromText(
    text: string,
    settings: Settings,
    context: SettingsContext,
  ): FieldResult;
};

/**
 * 画面に出す設定項目。
 *
 * パネルはこれを並べるだけで、項目ごとの分岐を持たない
 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  // **先頭に置く。** 他の項目の意味がモードによって変わる (最大秒数は合計に効く)
  {
    key: "mode",
    label: "モード",
    scope: "global",
    control: {
      kind: "select",
      options: [
        { value: "simple", label: "シンプル (1 区間を切り抜く)" },
        { value: "edit", label: "エディット (複数区間を結合する)" },
      ],
    },
    hint: () => "モードを変えると作りかけの区間は消えます",
    toText: (settings) => settings.mode,
    fromText: (text) => parseMode(text),
  },
  {
    key: "hashtags",
    label: "ハッシュタグ",
    scope: "channel",
    control: { kind: "text" },
    hint: (context) => {
      if (context.channel === null) {
        return "チャンネルを特定できないため設定できません";
      }
      return `空白区切り。# は省略できます (${context.channel.name} のタグ)`;
    },
    toText: (settings, context) =>
      formatHashtags(hashtagsFor(settings, context.channel?.id)),
    fromText: (text, settings, context) => {
      if (context.channel === null) {
        return {
          ok: false,
          message: "チャンネルを特定できないため保存できません",
        };
      }
      return {
        ok: true,
        patch: {
          // 他のチャンネル分は残す。丸ごと差し替えると、別のチャンネルで
          // 設定したタグが消える
          hashtagsByChannel: {
            ...settings.hashtagsByChannel,
            [context.channel.id]: normalizeHashtags(text),
          },
        },
      };
    },
  },
  {
    key: "maxClipSec",
    label: "最大秒数",
    scope: "global",
    control: { kind: "text" },
    hint: () =>
      `${MIN_CLIP_SEC}〜${MAX_SETTABLE_CLIP_SEC} 秒。X の動画の上限が ${MAX_SETTABLE_CLIP_SEC} 秒です`,

    toText: (settings) => String(settings.maxClipSec),
    fromText: (text) => parseMaxClipSec(text),
  },
  // テロップの見た目。**モードに関わらず常に出す。** パネルには項目をモードで
  // 出し分ける仕組みが無く、モード自体が同じパネルの未保存の選択肢なので、
  // 出し分けると選び直した瞬間に項目が出入りする処理まで要る
  {
    key: "telopFontSizePx",
    label: "テロップの文字サイズ",
    scope: "global",
    control: { kind: "text" },
    hint: () =>
      `エディットモードのテロップに使う。${TELOP_FONT_SIZE_RANGE.min}〜${TELOP_FONT_SIZE_RANGE.max} (1080p で見たときの px)`,
    toText: (settings) => String(settings.telopFontSizePx),
    fromText: (text) => parseTelopFontSize(text),
  },
  {
    key: "telopFont",
    label: "テロップのフォント",
    scope: "global",
    control: {
      kind: "text",
      suggestions: TELOP_FONT_PRESETS.map((preset) => preset.label),
    },
    hint: () =>
      "エディットモードのテロップに使う。候補から選ぶか、手元にあるフォントの名前を書く (無ければ代わりのフォントで描く)",
    toText: (settings) => settings.telopFont,
    fromText: (text) => parseTelopFont(text),
  },
  {
    key: "telopFillColor",
    label: "テロップの文字の色",
    scope: "global",
    control: { kind: "color" },
    hint: () => "エディットモードのテロップに使う",
    toText: (settings) => settings.telopFillColor,
    fromText: (text) => parseColor("telopFillColor", text),
  },
  {
    key: "telopStrokeColor",
    label: "テロップの縁取りの色",
    scope: "global",
    control: { kind: "color" },
    hint: () => "エディットモードのテロップに使う",
    toText: (settings) => settings.telopStrokeColor,
    fromText: (text) => parseColor("telopStrokeColor", text),
  },
  {
    key: "telopStrokeWidthPx",
    label: "テロップの縁取りの太さ",
    scope: "global",
    control: { kind: "text" },
    hint: () =>
      `エディットモードのテロップに使う。${TELOP_STROKE_WIDTH_RANGE.min}〜${TELOP_STROKE_WIDTH_RANGE.max}、0 で縁取りなし (1080p で見たときの px)`,
    toText: (settings) => String(settings.telopStrokeWidthPx),
    fromText: (text) => parseTelopStrokeWidth(text),
  },
];
