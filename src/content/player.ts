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
 * 見出しの要素構成が変わっても、ここは同じ形で残りやすい
 */
function titleFromDocument(): string | null {
  // 「(3) 動画名 - YouTube」のような未読件数と末尾を落とす
  const withoutCount = document.title.replace(/^\(\d+\)\s*/, "");
  const withoutSuffix = withoutCount.replace(/\s*-\s*YouTube\s*$/, "");
  const trimmed = withoutSuffix.trim();
  return trimmed === "" ? null : trimmed;
}

export function getVideoMeta(): VideoMeta {
  const title = findTitleInPage() ?? titleFromDocument();
  if (title === null) {
    // 空のまま進むと、投稿本文が改行だけで始まる不可解な形になる
    throw new ElementNotFoundError(YT_SELECTORS.title.join(" / "));
  }
  return { videoId: parseVideoId(location.href), title };
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
