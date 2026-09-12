import { describe, expect, test } from "vitest";
import {
  ACTION_EVENTS,
  ACTION_LABELS,
  PRIMARY_ACTIONS,
  actionsFor,
} from "@/content/actions";
import type { ClipState } from "@/shared/types";

const ALL_KINDS: ClipState["kind"][] = [
  "idle",
  "ready",
  "seeking",
  "recording",
  "encoding",
  "preview",
  "composing",
  "posted",
  "downloadable",
  "failed",
];

describe("actionsFor", () => {
  test("範囲ができたら録画できる", () => {
    expect(actionsFor("ready")).toEqual(["record"]);
  });

  test("進行中は操作を出さない", () => {
    // 押しても状態機械に拒まれるだけなので、出さない
    expect(actionsFor("seeking")).toEqual([]);
    expect(actionsFor("recording")).toEqual([]);
    expect(actionsFor("encoding")).toEqual([]);
  });

  test("録画できたら投稿か取り直し", () => {
    expect(actionsFor("preview")).toEqual(["post", "retake"]);
  });

  test("投稿した後はもう一度投稿できる", () => {
    expect(actionsFor("posted")).toEqual(["repost", "retake"]);
  });

  test("添付に失敗した後も投稿を試し直せる", () => {
    expect(actionsFor("downloadable")).toEqual(["repost", "retake"]);
  });

  test("投稿待ちからは抜けられる", () => {
    expect(actionsFor("composing")).toEqual(["retake"]);
  });

  test("失敗したら再試行", () => {
    expect(actionsFor("failed")).toEqual(["retry"]);
  });

  test("何も指定していなければ操作は出さない", () => {
    expect(actionsFor("idle")).toEqual([]);
  });
});

describe("操作の定義", () => {
  test("すべての操作に文言と送るイベントがある", () => {
    const used = new Set(ALL_KINDS.flatMap((kind) => actionsFor(kind)));

    for (const action of used) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(ACTION_EVENTS[action]).toBeTruthy();
    }
  });

  test("再投稿は投稿と同じイベントを送る", () => {
    // 状態機械から見れば同じ POST。文言だけが違う
    expect(ACTION_EVENTS.repost).toEqual(ACTION_EVENTS.post);
  });

  test("主操作はどの状態でも高々 1 つ", () => {
    // 押してほしいものが 2 つ並ぶと、どちらを押せばよいか分からなくなる
    for (const kind of ALL_KINDS) {
      const primaries = actionsFor(kind).filter((action) =>
        PRIMARY_ACTIONS.has(action),
      );
      expect(primaries.length).toBeLessThanOrEqual(1);
    }
  });
});
