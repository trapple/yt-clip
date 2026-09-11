/** X が受け付ける MP4 (H.264 / AAC) */
export const MP4_MIME = 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"';

/** MP4 非対応環境での退避先。X には直接添付できない */
export const WEBM_MIME = "video/webm;codecs=vp9,opus";

export type CodecChoice = {
  mimeType: string;
  /** X へ直接添付できる形式かどうか */
  mp4: boolean;
};

/**
 * 録画に使う MIME を決める。
 * テストから差し替えられるよう判定関数を引数で受け取る。
 */
export function pickMimeType(
  isTypeSupported: (type: string) => boolean = (type) =>
    MediaRecorder.isTypeSupported(type),
): CodecChoice {
  if (isTypeSupported(MP4_MIME)) {
    return { mimeType: MP4_MIME, mp4: true };
  }
  if (isTypeSupported(WEBM_MIME)) {
    return { mimeType: WEBM_MIME, mp4: false };
  }
  throw new Error("この環境では動画を録画できません");
}
