export class CapturePermissionError extends Error {
  constructor(cause: unknown) {
    super(`タブの録画を開始できませんでした: ${String(cause)}`);
    this.name = "CapturePermissionError";
  }
}

/** テストから差し替えられるよう、使う chrome API だけを型にする */
export type CaptureApi = {
  offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(params: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  runtime: { getURL(path: string): string };
  tabCapture: {
    getMediaStreamId(options: { targetTabId: number }): Promise<string>;
  };
};

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

function defaultApi(): CaptureApi {
  return chrome as unknown as CaptureApi;
}

/** offscreen document が無ければ作る。既にあれば何もしない */
export async function ensureOffscreen(
  api: CaptureApi = defaultApi(),
): Promise<void> {
  if (await api.offscreen.hasDocument()) return;

  await api.offscreen.createDocument({
    url: api.runtime.getURL(OFFSCREEN_PATH),
    reasons: ["USER_MEDIA"],
    justification: "タブの映像と音声を録画して切り抜きを作るため",
  });
}

/** 録画対象タブの streamId を取得する */
export async function getStreamId(
  tabId: number,
  api: CaptureApi = defaultApi(),
): Promise<string> {
  try {
    return await api.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    throw new CapturePermissionError(error);
  }
}

export async function closeOffscreen(
  api: CaptureApi = defaultApi(),
): Promise<void> {
  if (!(await api.offscreen.hasDocument())) return;
  await api.offscreen.closeDocument();
}
