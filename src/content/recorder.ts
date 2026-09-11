export class DrmProtectedError extends Error {
  constructor() {
    super("この動画は保護されているため録画できません");
    this.name = "DrmProtectedError";
  }
}

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

/** captureStream は標準の型定義に含まれないため補う */
type CapturableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
};

/**
 * この動画を録画してよいか確かめる。
 *
 * **録画を始める前に呼ぶこと。** 暗号化された動画の `captureStream()` は
 * 失敗せず黒画面を返すため、始めてしまうと実時間を払い切った後で
 * 無駄だったと分かることになる。
 */
export function assertRecordable(video: HTMLVideoElement): void {
  // `mediaKeys` を持たない環境では undefined になる。`!== null` で見ると
  // DRM でない動画まで保護扱いになり、どの動画も録画できなくなる
  if ((video.mediaKeys ?? null) !== null) {
    throw new DrmProtectedError();
  }
}

/** X が受け付ける音声チャンネル数の上限 */
export const MAX_AUDIO_CHANNELS = 2;

export type RecordingStream = {
  stream: MediaStream;
  /** 取得したリソースを解放する。二度呼ばれても安全 */
  release(): void;
};

/**
 * 録画に流し込むストリームを組み立てる。
 *
 * **音声を必ずステレオに落とすこと。** YouTube は 5.1 / 7.1 の音声を配信する
 * ことがあり、`captureStream()` はそれをそのまま通す。8ch のまま録ると、
 * ファイル自体は正しい MP4 なのに X のサーバ側の変換が落ち、投稿画面に
 * 「問題が発生しました」とだけ出る (実機で 8ch を確認済み)。
 *
 * 取得したトラックの `getSettings()` は `channelCount` を報告しないため、
 * **何 ch なのかは判定できない**。よって音声がある限り常に通す。
 */
export function buildRecordingStream(
  captured: MediaStream,
  createAudioContext: () => AudioContext = () => new AudioContext(),
): RecordingStream {
  const releaseCaptured = (): void => {
    for (const track of captured.getTracks()) {
      track.stop();
    }
  };

  const audioTrack = captured.getAudioTracks()[0];
  if (audioTrack === undefined) {
    return { stream: captured, release: releaseCaptured };
  }

  try {
    const context = createAudioContext();
    const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
    const destination = context.createMediaStreamDestination();
    // 既定でも 2ch だが、話者配置に沿って混ぜる規則ごと明示しておく
    destination.channelCount = MAX_AUDIO_CHANNELS;
    destination.channelCountMode = "explicit";
    destination.channelInterpretation = "speakers";
    source.connect(destination);

    const downmixed = destination.stream.getAudioTracks()[0];
    if (downmixed === undefined) {
      throw new Error("ステレオに落とした音声を取り出せませんでした");
    }

    return {
      stream: new MediaStream([...captured.getVideoTracks(), downmixed]),
      release(): void {
        downmixed.stop();
        void context.close();
        releaseCaptured();
      },
    };
  } catch (error) {
    // ここで録画ごと失敗させない。8ch のままでも録画は成立し、
    // ダウンロードして使う道は残る。塞がるのは X への添付だけなので、
    // 後から原因を追えるよう理由は必ず残す
    console.warn(
      `音声をステレオに落とせませんでした。X への添付が通らない可能性があります: ${String(error)}`,
    );
    return { stream: captured, release: releaseCaptured };
  }
}

/**
 * 再生中の動画そのものを録画する。
 *
 * タブではなく `video` 要素から直接ストリームを取るので、コメント欄や
 * プレイヤーの操作系は映らず、解像度も再生中の表示サイズに縛られない。
 * `captureStream()` はタブの音声出力を奪わないため、取得した音声を
 * スピーカーへ流し戻す処理 (旧 offscreen 版の AudioContext) は不要。
 * ただし音声をステレオに落とすためだけに AudioContext は経由する
 * (`buildRecordingStream` 参照)。
 *
 * リソース解放の設計:
 * `stop` イベントは明示的な `stop()` 呼び出しだけでなく、録画が致命的エラーで
 * 死んだときにブラウザ側からも発火する。そのため `onstop` は `start()` の直後に
 * 一度だけ装着し、どちらの経路でも必ず解放が走るようにする。`stop()` の中で
 * 装着すると、自動発火を取りこぼしてストリームが解放されないまま残る。
 */
export async function startRecording(
  video: HTMLVideoElement,
  mimeType: string,
  options: RecorderOptions,
): Promise<RecorderHandle> {
  const target = video as CapturableVideo;
  if (typeof target.captureStream !== "function") {
    throw new Error("この環境では動画を直接録画できません");
  }

  const recording = buildRecordingStream(target.captureStream());
  const stream = recording.stream;

  /** 取得済みのリソースを解放する。二度呼ばれても安全 */
  function release(): void {
    recording.release();
  }

  try {
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
