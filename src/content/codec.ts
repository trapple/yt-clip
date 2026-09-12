/**
 * X が受け付ける MP4 (H.264 High / AAC)。
 *
 * **Baseline を指定してはいけない。** `avc1.42E01E` のように制約フラグ付きで
 * 頼んでも、実機のエンコーダは制約フラグを立てず素の Baseline
 * (profile_idc=66, 制約フラグ 0x00) を出す。X はこれを受け取った後の変換で
 * 失敗する ("Internal error[131]")。実機で片方ずつ入れ替えて確かめた:
 *
 * | 映像 | 音声 | X |
 * |------|------|---|
 * | 素の Baseline | そのまま | 失敗 |
 * | 素の Baseline | 作り直し | 失敗 |
 * | High に作り直し | そのまま | 成功 |
 *
 * High / Main はどちらも指定どおりのプロファイルで出てくる (実測)。
 * level は指定に関わらずエンコーダが解像度に合わせて決める。
 */
export const MP4_MIME = 'video/mp4;codecs="avc1.640028,mp4a.40.2"';

/** MP4 非対応環境での退避先。X には直接添付できない */
export const WEBM_MIME = "video/webm;codecs=vp9,opus";

/**
 * MIME からパラメータ (`;codecs=...` など) を落として型だけにする。
 *
 * `MediaRecorder` はコーデックまで指定した MIME を必要とするが、**その MIME を
 * そのまま `File` / `Blob` のラベルに使ってはいけない。** `File.type` は
 * パラメータを保持するため、X の「対応形式か」の判定に落ちて
 * 「一部の画像/動画をアップロードできません。」になる。中身は正しい MP4 なのに
 * ラベルだけで弾かれる、という形で表に出る。
 *
 * コーデック付きの MIME を使ってよいのは `MediaRecorder` と
 * `MediaRecorder.isTypeSupported` だけ。
 */
export function baseMimeType(mime: string): string {
  const base = mime.split(";")[0] ?? "";
  return base.trim();
}

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
