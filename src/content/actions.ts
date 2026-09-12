import type { ClipEvent, ClipState } from "@/shared/types";

/**
 * ページ内バーに出す操作。
 *
 * IN / OUT / 範囲を見る は状態に関わらず常に出ている別枠なので、ここには
 * 含めない。ここに並ぶのは「いまの状態でだけ意味を持つ操作」。
 */
export type BarAction = "record" | "post" | "repost" | "retake" | "retry";

export const ACTION_LABELS: Record<BarAction, string> = {
  record: "● 録画",
  post: "X に投稿",
  repost: "X にもう一度投稿",
  retake: "取り直す",
  retry: "再試行",
};

/** 状態機械から見れば repost も post も同じ POST。文言だけが違う */
export const ACTION_EVENTS: Record<BarAction, ClipEvent> = {
  record: { type: "START_RECORDING" },
  post: { type: "POST" },
  repost: { type: "POST" },
  retake: { type: "RETAKE" },
  retry: { type: "RETRY" },
};

/** 押してほしいものを 1 つに絞る。主操作は塗り、副操作は輪郭だけ */
export const PRIMARY_ACTIONS: ReadonlySet<BarAction> = new Set([
  "record",
  "post",
  "repost",
]);

/** その状態で出す操作。網羅性は switch で保証する */
export function actionsFor(kind: ClipState["kind"]): BarAction[] {
  switch (kind) {
    case "idle":
      return [];
    case "ready":
      return ["record"];
    // 進行中は押しても状態機械に拒まれるだけなので出さない
    case "seeking":
    case "recording":
    case "encoding":
      return [];
    case "preview":
      return ["post", "retake"];
    case "composing":
      return ["retake"];
    case "posted":
      return ["repost", "retake"];
    case "downloadable":
      return ["repost", "retake"];
    case "failed":
      return ["retry"];
  }
}
