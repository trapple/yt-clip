export type RecorderHandle = {
  /** 録画を止めて Blob を確定させる */
  stop(): Promise<Blob>;
};

export type RecorderOptions = {
  /**
   * 明示的な `stop()` より前に録画が終わってしまったときに呼ばれる。
   * 録画中の異常を呼び出し側が即座に知るための唯一の経路であり、
   * これが無いと OUT 到達まで (最大 60 秒) 異常に気付けない。
   */
  onUnexpectedStop(error: Error): void;
};

/** tabCapture の streamId から MediaStream を得るための制約 */
function tabConstraints(streamId: string): MediaStreamConstraints {
  // chromeMediaSource は標準の型定義に存在しないため cast する
  return {
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  } as unknown as MediaStreamConstraints;
}

/**
 * タブの映像・音声を録画する。
 * streamId 以外の文脈 (YouTube / X / 状態機械) を一切知らない。
 *
 * リソース解放の設計:
 * `stop` イベントは明示的な `stop()` 呼び出しだけでなく、録画が致命的エラーで
 * 死んだときにブラウザ側からも発火する。そのため `onstop` は `start()` の直後に
 * 一度だけ装着し、どちらの経路でも必ず解放が走るようにする。`stop()` の中で
 * 装着すると、自動発火を取りこぼしてストリームが解放されないまま残る。
 */
export async function startRecording(
  streamId: string,
  mimeType: string,
  options: RecorderOptions,
): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(
    tabConstraints(streamId),
  );

  let audioContext: AudioContext | null = null;

  /** 取得済みのリソースを解放する。二度呼ばれても安全 */
  function release(): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (audioContext !== null) {
      void audioContext.close();
      audioContext = null;
    }
  }

  try {
    // tabCapture 中はタブ音声がスピーカーから消えるため、取得した音声を出力へ流し戻す
    audioContext = new AudioContext();
    audioContext
      .createMediaStreamSource(stream)
      .connect(audioContext.destination);

    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    let recordingError: Error | null = null;
    /** 録画が終わった (自動・明示どちらでも) ときに解決する */
    let settleStopped: (() => void) | null = null;
    let stopped = false;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      recordingError = new Error(`録画中にエラーが発生しました: ${event.type}`);
    };
    recorder.onstop = () => {
      stopped = true;
      release();

      if (settleStopped !== null) {
        settleStopped();
        return;
      }
      // stop() を待たずに終了した = 録画中の異常。呼び出し側へ即座に知らせる
      options.onUnexpectedStop(
        recordingError ?? new Error("録画が予期せず終了しました"),
      );
    };

    // 1 秒ごとに chunk を吐かせ、長い録画でもメモリが一度に膨らまないようにする
    recorder.start(1000);

    return {
      stop() {
        return new Promise<Blob>((resolve, reject) => {
          const finish = (): void => {
            if (recordingError !== null) {
              reject(recordingError);
              return;
            }
            resolve(new Blob(chunks, { type: mimeType }));
          };

          // 既にエラーで停止済みなら、改めて stop() を呼ばずに結果を返す
          if (stopped) {
            finish();
            return;
          }

          settleStopped = finish;
          recorder.stop();
        });
      },
    };
  } catch (error) {
    // 録画を開始できなかった場合、取得済みのストリームを掴んだままにしない
    release();
    throw error;
  }
}
