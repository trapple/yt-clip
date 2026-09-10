export type RecorderHandle = {
  /** 録画を止めて Blob を確定させる */
  stop(): Promise<Blob>;
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
 */
export async function startRecording(
  streamId: string,
  mimeType: string,
): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(
    tabConstraints(streamId),
  );

  // tabCapture 中はタブ音声がスピーカーから消えるため、取得した音声を出力へ流し戻す
  const audioContext = new AudioContext();
  audioContext
    .createMediaStreamSource(stream)
    .connect(audioContext.destination);

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  let recordingError: Error | null = null;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.onerror = (event) => {
    recordingError = new Error(`録画中にエラーが発生しました: ${event.type}`);
  };

  // 1 秒ごとに chunk を吐かせ、長い録画でもメモリが一度に膨らまないようにする
  recorder.start(1000);

  function cleanup(): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    void audioContext.close();
  }

  return {
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          cleanup();
          if (recordingError !== null) {
            reject(recordingError);
            return;
          }
          resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.stop();
      });
    },
  };
}
