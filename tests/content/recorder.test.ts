// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DrmProtectedError,
  MAX_AUDIO_CHANNELS,
  assertRecordable,
  buildRecordingStream,
} from "@/content/recorder";

/** mediaKeys は読み取り専用なので、テストからは定義し直して差し替える */
function makeVideo(mediaKeys: unknown): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "mediaKeys", {
    value: mediaKeys,
    configurable: true,
  });
  return video;
}

describe("assertRecordable", () => {
  test("保護されていない動画は通す", () => {
    expect(() => assertRecordable(makeVideo(null))).not.toThrow();
  });

  test("暗号化されている動画は録画前に弾く", () => {
    // captureStream は黒画面を返すだけで失敗しないため、
    // ここで止めないと実時間を払った後で無駄と分かることになる
    expect(() => assertRecordable(makeVideo({}))).toThrow(DrmProtectedError);
  });

  test("失敗の理由が分かるメッセージを持つ", () => {
    expect(() => assertRecordable(makeVideo({}))).toThrow(
      "この動画は保護されているため録画できません",
    );
  });
});

/** jsdom は MediaStream を持たないので、必要な範囲だけ用意する */
class FakeStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

class FakeTrack {
  stopped = false;
  constructor(
    readonly kind: "audio" | "video",
    readonly label = "",
  ) {}
  stop(): void {
    this.stopped = true;
  }
}

type Recorded = {
  destination: {
    channelCount: number;
    channelCountMode: string;
    channelInterpretation: string;
    stream: FakeStream;
  };
  closed: boolean;
  connected: boolean;
};

function makeAudioContext(): { create: () => AudioContext; log: Recorded } {
  const downmixed = new FakeTrack("audio", "downmixed");
  const log: Recorded = {
    destination: {
      channelCount: 0,
      channelCountMode: "",
      channelInterpretation: "",
      stream: new FakeStream([downmixed]),
    },
    closed: false,
    connected: false,
  };
  const context = {
    createMediaStreamSource: () => ({
      connect: () => {
        log.connected = true;
      },
    }),
    createMediaStreamDestination: () => log.destination,
    close: () => {
      log.closed = true;
      return Promise.resolve();
    },
  };
  return { create: () => context as unknown as AudioContext, log };
}

describe("buildRecordingStream", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: FakeTrack[] = []) {}
        getTracks(): FakeTrack[] {
          return this.tracks;
        }
        getAudioTracks(): FakeTrack[] {
          return this.tracks.filter((t) => t.kind === "audio");
        }
        getVideoTracks(): FakeTrack[] {
          return this.tracks.filter((t) => t.kind === "video");
        }
      },
    );
  });

  test("音声をステレオに落として録画に渡す", () => {
    // 8ch のまま録ると、正しい MP4 なのに X の変換が落ちて
    // 「問題が発生しました」になる。実機で 8ch を確認済み
    const captured = new FakeStream([
      new FakeTrack("video"),
      new FakeTrack("audio", "captured"),
    ]);
    const { create, log } = makeAudioContext();

    const built = buildRecordingStream(
      captured as unknown as MediaStream,
      create,
    );

    expect(log.connected).toBe(true);
    expect(log.destination.channelCount).toBe(MAX_AUDIO_CHANNELS);
    expect(log.destination.channelCountMode).toBe("explicit");
    const audio = built.stream.getAudioTracks() as unknown as FakeTrack[];
    expect(audio).toHaveLength(1);
    expect(audio[0]?.label).toBe("downmixed");
  });

  test("映像はそのまま持ち越す", () => {
    const video = new FakeTrack("video");
    const captured = new FakeStream([video, new FakeTrack("audio")]);
    const built = buildRecordingStream(
      captured as unknown as MediaStream,
      makeAudioContext().create,
    );
    expect(built.stream.getVideoTracks()).toEqual([video]);
  });

  test("音声が無ければそのまま使う", () => {
    const captured = new FakeStream([new FakeTrack("video")]);
    const built = buildRecordingStream(
      captured as unknown as MediaStream,
      () => {
        throw new Error("音声が無いのに AudioContext を作ってはいけない");
      },
    );
    expect(built.stream).toBe(captured as unknown as MediaStream);
  });

  test("解放すると元のトラックも AudioContext も始末する", () => {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const captured = new FakeStream([video, audio]);
    const { create, log } = makeAudioContext();

    buildRecordingStream(captured as unknown as MediaStream, create).release();

    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
    expect(log.closed).toBe(true);
  });

  test("ステレオに落とせなくても録画自体は続ける", () => {
    // 8ch でも録画は成立し、ダウンロードして使う道は残る。
    // ここで録画ごと失敗させる方が損失が大きい
    const captured = new FakeStream([
      new FakeTrack("video"),
      new FakeTrack("audio"),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const built = buildRecordingStream(captured as unknown as MediaStream, () => {
      throw new Error("AudioContext を作れません");
    });

    expect(built.stream).toBe(captured as unknown as MediaStream);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("音声をステレオに落とせませんでした"),
    );
    warn.mockRestore();
  });
});
