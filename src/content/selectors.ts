/**
 * DOM セレクタの集約。
 * YouTube / X の画面構成が変わったとき、修正箇所をこの 1 ファイルに閉じ込める。
 */
export const YT_SELECTORS = {
  video: "video.html5-main-video",
  player: "#movie_player",
  /**
   * 操作 UI を差し込む位置。プレイヤーの直下にあり、動画ページの間は残り続ける。
   * プレイヤー内部の操作列 (.ytp-right-controls) に入れると、列の高さに収まらず、
   * さらにマウスを外したときプレイヤーの UI ごと隠れてしまう
   */
  mountAnchor: "#below",
  /**
   * 動画タイトル。画面構成によって当たる要素が変わるため候補を順に試す。
   * 実機で、先頭の候補に一致はするが中身が空になる環境があった
   * (本文にタイトルが入らない形で表に出た)
   */
  title: [
    "h1.ytd-watch-metadata yt-formatted-string",
    "#title h1 yt-formatted-string",
    "h1.title yt-formatted-string",
    'meta[itemprop="name"]',
  ],
  /** 範囲を帯で重ねる対象。プレイヤーのシークバー */
  progressBar: ".ytp-progress-bar",
} as const;

export const X_SELECTORS = {
  /** 添付用の input。data-testid が変わる可能性があるため候補を順に試す */
  fileInput: [
    'input[data-testid="fileInput"]',
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
  ],
  /** 本文の contenteditable */
  editor: [
    'div[data-testid="tweetTextarea_0"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
} as const;
