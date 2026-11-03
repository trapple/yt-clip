/**
 * DOM セレクタの集約。
 * YouTube / X の画面構成が変わったとき、修正箇所をこの 1 ファイルに閉じ込める。
 */
export const YT_SELECTORS = {
  video: "video.html5-main-video",
  player: "#movie_player",
  /**
   * 動画ページのページができたかの目印。プレイヤーの直下にあり、動画ページの間は残り続ける。
   * **操作 UI はもうここに差し込まない** (body 直下のフロートの窓に入れる。
   * `.claude/specs/2026-09-24-floating-windows-design.md` A.3)。これが無い間に操作 UI を作ると、
   * タイトルもプレイヤーも読めないまま IN を押せてしまう
   */
  mountAnchor: "#below",
  /**
   * 下のドック枠を差す先 (`.claude/specs/2026-09-25-dockable-windows-design.md` C2.1)。**先頭に差す**
   * (`ytd-watch-metadata` の上)。mountAnchor と同じ要素: 右側パネル化の前にバーがあった場所で、再描画で外れたときの
   * 差し直しも実績がある。実測は dock.ts のコメント
   */
  dockBelow: "#below",
  /**
   * 右のドック枠を差す先。候補を順に試し、**先頭に差す** (おすすめ動画 `#related` とチャット `#chat` の上)。
   * `#secondary` 直下を先にしない: YouTube が `#secondary-inner` を作り直したとき、枠が列の外に残りうる
   */
  dockSide: ["#secondary-inner", "#secondary"],
  /**
   * 動画ページの根。シアターモードの間 `theater` 属性が立つ。**拡張はこれを見て窓を動かさない** (シアターモードでも
   * 右の枠は右の列に付いて動画の下へ回るまま。C2.1)。E2E の実測が同じ要素を読む
   */
  watchFlexy: "ytd-watch-flexy",
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
  /**
   * チャンネルへのリンク。ここから `UC...` かハンドル (`@name`) を取り出す。
   *
   * **実機では `UC...` はもうページに出ていない** (2026-09 時点)。
   * `meta[itemprop="channelId"]` は存在せず、オーナー欄のリンクもすべて
   * ハンドルだった。**鍵にはハンドルを優先し**、`UC...` は保険として探す
   * (理由は player.ts の getChannel を参照)。
   *
   * **構造化データ (schema.org) を先に置く。** 見た目のレイアウトは
   * A/B テストで利用者ごとに違いうるが、こちらは変わりにくい
   */
  channelLink: [
    'meta[itemprop="channelId"]',
    'span[itemprop="author"] link[itemprop="url"]',
    "#owner ytd-channel-name a",
    "ytd-video-owner-renderer a",
    "#upload-info a",
    "#owner a",
    "ytd-channel-name a",
  ],
  /** チャンネル名。表示にしか使わない */
  channelName: [
    'span[itemprop="author"] link[itemprop="name"]',
    "#owner ytd-channel-name a",
    "ytd-channel-name #text",
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
