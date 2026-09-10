import { describe, expect, test } from "vitest";
import {
  CapturePermissionError,
  closeOffscreen,
  ensureOffscreen,
  getStreamId,
  type CaptureApi,
} from "@/background/capture";

function makeApi(overrides: Partial<{
  hasDocument: boolean;
  streamId: string | Error;
}> = {}): { api: CaptureApi; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    createDocument: [],
    closeDocument: [],
    getMediaStreamId: [],
  };
  const api: CaptureApi = {
    offscreen: {
      hasDocument: async () => overrides.hasDocument ?? false,
      createDocument: async (params) => {
        calls.createDocument!.push(params);
      },
      closeDocument: async () => {
        calls.closeDocument!.push(true);
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabCapture: {
      getMediaStreamId: async (options) => {
        calls.getMediaStreamId!.push(options);
        const result = overrides.streamId ?? "stream-abc";
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { api, calls };
}

describe("ensureOffscreen", () => {
  test("offscreen が無ければ USER_MEDIA 理由で作る", async () => {
    const { api, calls } = makeApi({ hasDocument: false });
    await ensureOffscreen(api);

    expect(calls.createDocument).toHaveLength(1);
    expect(calls.createDocument![0]).toMatchObject({
      url: "chrome-extension://test/src/offscreen/offscreen.html",
      reasons: ["USER_MEDIA"],
    });
  });

  test("既に存在すれば作り直さない", async () => {
    const { api, calls } = makeApi({ hasDocument: true });
    await ensureOffscreen(api);

    expect(calls.createDocument).toHaveLength(0);
  });
});

describe("getStreamId", () => {
  test("対象タブの streamId を返す", async () => {
    const { api, calls } = makeApi({ streamId: "stream-xyz" });

    await expect(getStreamId(42, api)).resolves.toBe("stream-xyz");
    expect(calls.getMediaStreamId![0]).toEqual({ targetTabId: 42 });
  });

  test("取得に失敗したら CapturePermissionError にして throw する", async () => {
    const { api } = makeApi({ streamId: new Error("権限がありません") });

    await expect(getStreamId(42, api)).rejects.toThrow(CapturePermissionError);
  });
});

describe("closeOffscreen", () => {
  test("存在するときだけ閉じる", async () => {
    const present = makeApi({ hasDocument: true });
    await closeOffscreen(present.api);
    expect(present.calls.closeDocument).toHaveLength(1);

    const absent = makeApi({ hasDocument: false });
    await closeOffscreen(absent.api);
    expect(absent.calls.closeDocument).toHaveLength(0);
  });
});
