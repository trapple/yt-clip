/**
 * DOM セレクタの集約。
 * YouTube / X の画面構成が変わったとき、修正箇所をこの 1 ファイルに閉じ込める。
 */
export const YT_SELECTORS = {
  video: "video.html5-main-video",
  player: "#movie_player",
  controls: ".ytp-right-controls",
  title: "h1.ytd-watch-metadata yt-formatted-string",
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
