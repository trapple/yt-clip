import { YT_SELECTORS } from "@/content/selectors";
import type { VideoMeta } from "@/shared/types";

export class ElementNotFoundError extends Error {
  constructor(selector: string) {
    super(`要素が見つかりません: ${selector}`);
    this.name = "ElementNotFoundError";
  }
}

/** requestVideoFrameCallback は標準の型定義に含まれないため補う */
type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback(callback: FrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
};

export function parseVideoId(url: string): string {
  const videoId = new URL(url).searchParams.get("v");
  if (videoId === null || videoId === "") {
    throw new Error(`URL から videoId を取得できません: ${url}`);
  }
  return videoId;
}

export function getVideo(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>(YT_SELECTORS.video);
  if (video === null) {
    throw new ElementNotFoundError(YT_SELECTORS.video);
  }
  return video;
}

/** 広告再生中は player 要素に ad-showing クラスが付く */
export function isAdPlaying(): boolean {
  const player = document.querySelector(YT_SELECTORS.player);
  return player?.classList.contains("ad-showing") ?? false;
}

/**
 * 要素が指している**識別子**を取り出す。
 *
 * リンクは `href`、meta は `content`。**リンクの表示文字列は使わない。**
 * `<a href="/channel/UC...">チャンネル名</a>` から名前を拾ってしまうと、
 * 設定の鍵に名前が入り、チャンネル名が変わった瞬間にタグが引けなくなる
 */
function identityOf(element: Element): string {
  if (element instanceof HTMLMetaElement) return element.content.trim();
  // **絶対 URL (`href` プロパティ) を読む。** 属性は相対にも絶対にもなり、
  // ページによってどちらが来るか分からない。絶対に揃えれば取り出し方は 1 つで済む
  if (element instanceof HTMLAnchorElement) return element.href.trim();
  if (element instanceof HTMLLinkElement) return element.href.trim();
  return (element.textContent ?? "").trim();
}

/**
 * 要素が示す**表示名**を取り出す。
 * `link[itemprop=name]` は表示されないので `content` に名前を持つ
 */
function labelOf(element: Element): string {
  const text = (element.textContent ?? "").trim();
  if (text !== "") return text;
  return element.getAttribute("content")?.trim() ?? "";
}

/**
 * 候補を順に試し、中身が空でない最初のものを採る。
 *
 * **要素に一致するだけでは足りない。** 実機に、先頭の候補に一致はするが
 * 中身が空になる画面構成があった (タイトルで実際に起きた)
 */
function firstValue(
  selectors: readonly string[],
  read: (element: Element) => string,
): string | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const value = read(element);
      if (value !== "") return value;
    }
  }
  return null;
}

/** 候補に一致するものを**すべて**集める。中身が空のものは飛ばす */
function allValues(
  selectors: readonly string[],
  read: (element: Element) => string,
): string[] {
  const values: string[] = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const value = read(element);
      if (value !== "") values.push(value);
    }
  }
  return values;
}

/** 変換して最初に null でなかったものを返す */
function firstMapped<T>(
  values: readonly string[],
  convert: (value: string) => T | null,
): T | null {
  for (const value of values) {
    const converted = convert(value);
    if (converted !== null) return converted;
  }
  return null;
}

/**
 * ページ見出しから動画タイトルを拾う。
 *
 * 候補を順に試し、**中身が空でない最初のもの**を採る。要素に一致するだけでは
 * 足りない: 実機に、先頭の候補に一致はするが中身が空になる画面構成があり、
 * 投稿本文からタイトルだけが消える形で表に出た。
 */
function findTitleInPage(): string | null {
  for (const selector of YT_SELECTORS.title) {
    const element = document.querySelector(selector);
    if (element === null) continue;

    // meta 要素は表示されないので content 属性に入っている
    const text =
      element instanceof HTMLMetaElement
        ? element.content
        : (element.textContent ?? "");
    const trimmed = text.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * タブのタイトルから動画タイトルを復元する。
 * 見出しの要素構成が変わっても、ここは同じ形で残りやすい。
 *
 * **最後の手段であり、古いタイトルが混じりうる。** 見出しが空になるのは
 * SPA 遷移の途中で、`document.title` の更新はそれと同期していない。
 * videoId と URL は正しいのでタイトルだけが前の動画のものになる
 */
function titleFromDocument(): string | null {
  // 「(3) 動画名 - YouTube」のような未読件数と末尾を落とす
  const withoutCount = document.title.replace(/^\(\d+\)\s*/, "");
  const withoutSuffix = withoutCount.replace(/\s*-\s*YouTube\s*$/, "");
  const trimmed = withoutSuffix.trim();
  return trimmed === "" ? null : trimmed;
}

/** URL や文字列から `UC...` を取り出す。href そのままでは鍵にできない */
function extractChannelId(value: string): string | null {
  const fromPath = /\/channel\/(UC[\w-]+)/u.exec(value);
  if (fromPath !== null && fromPath[1] !== undefined) return fromPath[1];
  // meta の content は ID がそのまま入っている
  if (/^UC[\w-]+$/u.test(value)) return value;
  return null;
}

/** href から `@handle` を取り出す */
function extractHandle(value: string): string | null {
  const matched = /\/(@[\w.-]+)/u.exec(value);
  return matched?.[1] ?? null;
}

/**
 * チャンネルを特定する。
 *
 * **見つからなくても throw しない。** タイトルと違い、チャンネルが分からなくても
 * 投稿本文は成立する (タグが付かないだけ)。ここで止めると、画面構成が
 * 少し変わっただけで録画そのものができなくなる
 */
export function getChannel(): { id: string; name: string } {
  // **候補を全部集めてから探す。** 「順に試して最初の 1 つ」だと、リストの
  // 前の方にある UC... のリンクが先に当たり、ハンドルを見ずに終わる
  const candidates = allValues(YT_SELECTORS.channelLink, identityOf);
  const id =
    // **ハンドルを優先する。** UC... の方が本来は安定した識別子だが、
    // いま取れるとは限らない (メンバーシップのあるチャンネルだけ
    // /channel/UC.../join が出る、といった差が実際にありうる)。優先すると
    // 同じチャンネルなのに動画によって鍵が変わり、設定したタグが別の動画で
    // 出てこなくなる。ハンドルはどの watch ページにも必ず出ている
    firstMapped(candidates, extractHandle) ??
    firstMapped(candidates, extractChannelId);

  const name = firstValue(YT_SELECTORS.channelName, labelOf);

  if (id === null) {
    // **集まった候補をそのまま出す。** 「特定できません」だけでは、
    // 次に何を直せばよいか分からない
    console.warn(
      `[yt-clip] チャンネルを特定できませんでした (候補 ${candidates.length} 件: ${candidates.slice(0, 5).join(" / ")})`,
    );
  }
  return { id: id ?? "", name: name ?? id ?? "" };
}

export function getVideoMeta(): VideoMeta {
  const title = findTitleInPage() ?? titleFromDocument();
  if (title === null) {
    // 空のまま進むと、投稿本文が改行だけで始まる不可解な形になる
    throw new ElementNotFoundError(YT_SELECTORS.title.join(" / "));
  }
  const channel = getChannel();
  return {
    videoId: parseVideoId(location.href),
    title,
    channelId: channel.id,
    channelName: channel.name,
  };
}

/**
 * 指定位置へ seek し、完了を待つ。
 * seeked が来ないまま固まるのを防ぐため必ずタイムアウトを設ける。
 */
export function seekTo(
  video: HTMLVideoElement,
  sec: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`seek がタイムアウトしました: ${sec}秒`));
    }, timeoutMs);

    video.addEventListener("seeked", onSeeked);
    video.currentTime = sec;
  });
}

/**
 * 再生を開始し、実際に再生が始まるまで待つ。
 * seek とは分離してある。録画が実際に始まる (content script が recorder/started を
 * 送り、service worker が recording へ進める) まで動画を止めておかないと、
 * クリップの冒頭が欠けるため。
 */
export function startPlayback(
  video: HTMLVideoElement,
  timeoutMs = 5000,
): Promise<void> {
  // 倍速のまま録画すると早送り映像が記録されるので等速に戻す
  video.playbackRate = 1;

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener("playing", onPlaying);
    };
    const onPlaying = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("再生開始がタイムアウトしました"));
    }, timeoutMs);

    video.addEventListener("playing", onPlaying);
    void video.play();
  });
}

/**
 * 指定位置への到達をフレーム単位で監視する。
 * timeupdate は発火間隔が粗く末尾が伸びるため rVFC を使う。
 * 戻り値を呼ぶと監視を解除する。
 */
export function onReachTime(
  video: HTMLVideoElement,
  sec: number,
  onReach: () => void,
): () => void {
  const target = video as VideoWithFrameCallback;
  let cancelled = false;
  let handle = 0;

  const tick: FrameCallback = (_now, metadata) => {
    if (cancelled) return;
    if (metadata.mediaTime >= sec) {
      onReach();
      return;
    }
    handle = target.requestVideoFrameCallback(tick);
  };

  handle = target.requestVideoFrameCallback(tick);

  return () => {
    cancelled = true;
    target.cancelVideoFrameCallback(handle);
  };
}
