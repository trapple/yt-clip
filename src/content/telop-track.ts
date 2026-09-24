/**
 * 拡大バーの下に出すテロップの帯の段 (`.claude/specs/2026-09-24-floating-windows-design.md` B)。
 *
 * **時間の軸は持たない。** 拡大バー (range-bar.ts) が映している窓を受け取り、同じ軸で帯を置く。
 * 段の割り当て・窓に入るテロップ・掴んだ場所・ドラッグの計算は純粋関数に切り出してある
 * (DOM を組まずに境界を確かめるため)。
 *
 * 帯を動かして変えるのは**出す時間**だけ。文言は一覧 (telop-list.ts) で直す
 */

import { timeToRatio, type TimeWindow } from "@/content/range-math";
import { TELOP_TRACK_STYLE } from "@/content/styles";
import { formatTime } from "@/shared/time";
import type { Telop } from "@/shared/types";

/** 段の数の上限 (spec B.1)。3 段 (48px〜) だと 1440x795 でバーがプレイヤーの下端を覆う */
export const MAX_TELOP_LANES = 2;
/** 段の高さと段の間 (spec B.1)。2 段で 30px、拡大バーのトラックとの間 4px を足して 34px */
export const TELOP_LANE_HEIGHT_PX = 14;
export const TELOP_LANE_GAP_PX = 2;
/** 帯のドラッグで作れる最短の長さ (秒。spec B.2) */
export const MIN_TELOP_DRAG_SEC = 0.5;
/** 帯の端として掴める幅の上限 (px)。実際の幅は帯の幅の 1/3 との小さい方 (spec B.2) */
export const TELOP_EDGE_MAX_PX = 6;
/** これ未満しか動かさずに離したら、ドラッグではなくクリック (spec B.2) */
export const TELOP_CLICK_SLOP_PX = 4;

/** 帯のどこを掴んだか。中 = 長さを保って動かす、端 = 開始か終了だけを動かす */
export type TelopDragKind = "move" | "start" | "end";

/** 時刻だけを見る計算の入力と出力。文言は要らない */
export type TelopSpan = { startSec: number; endSec: number };

/**
 * 窓に一部でも入るテロップの位置 (index。元の並び)。**空の文言も入れる** (まだ書いていない
 * テロップも帯で動かせるように。spec B.1)。端が接するだけのものは入れない (テロップは半開区間。
 * `overlapsSegments` と同じ判定)
 */
export function telopsInWindow(telops: readonly TelopSpan[], window: TimeWindow): number[] {
  const indices: number[] = [];
  telops.forEach((telop, index) => {
    if (telop.startSec < window.endSec && window.startSec < telop.endSec) {
      indices.push(index);
    }
  });
  return indices;
}

/**
 * 時間が重なるテロップを段に分ける (spec B.1「前から順に、空いている段に置く」)。
 * 戻り値は入力と同じ並びで、各テロップの段 (0 始まり)。**どの段にも入らないものは -1** で、帯は
 * 出さず「+N」で数だけ出す (重ねて置くと、重なった帯をうっかり掴んで別のテロップを動かす)。
 *
 * 開始の早い順 (同じ開始なら作った順) に、いちばん若い空いた段へ置く。作った順に置くと、後から
 * 足した早いテロップが 2 段目に回り、時間の流れと段の並びが食い違って読みにくい
 */
export function assignLanes(telops: readonly TelopSpan[], maxLanes: number): number[] {
  if (!Number.isInteger(maxLanes) || maxLanes < 1) {
    throw new RangeError(`段の数が不正です: ${maxLanes}`);
  }
  const order = telops
    .map((telop, index) => ({ telop, index }))
    .sort((a, b) => a.telop.startSec - b.telop.startSec || a.index - b.index);
  /** 段ごとの、いま置いてある最後のテロップの終了 */
  const laneEnds: number[] = [];
  const lanes = telops.map(() => -1);
  for (const { telop, index } of order) {
    // 半開区間なので、前のテロップの終了ちょうどに始まるなら同じ段に置ける
    const free = laneEnds.findIndex((end) => end <= telop.startSec);
    if (free >= 0) {
      laneEnds[free] = telop.endSec;
      lanes[index] = free;
    } else if (laneEnds.length < maxLanes) {
      lanes[index] = laneEnds.length;
      laneEnds.push(telop.endSec);
    }
    // どの段にも入らないものは -1 のまま。段を塞がないので、後のテロップは空いた段に入れる
  }
  return lanes;
}

/**
 * 帯のどこを掴んだか。端の幅は「帯の幅の 1/3、最大 6px」(spec B.2)。細い帯でも中を掴めるように
 * 1/3 で頭打ちにする。ちょうど境目は中。幅が測れない (0) ときも中
 */
export function grabKindAt(offsetPx: number, widthPx: number): TelopDragKind {
  const edge = Math.min(TELOP_EDGE_MAX_PX, widthPx / 3);
  if (offsetPx < edge) return "start";
  if (offsetPx > widthPx - edge) return "end";
  return "move";
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

/**
 * 帯を動かした結果の時刻 (spec B.2)。
 *
 * 動かせる範囲は拡大バーの窓の中。**ただし、もともと窓からはみ出している分はそのまま認める**
 * (下限は min(窓の開始, 今の開始)、上限は max(窓の終了, 今の終了))。窓の端をまたぐテロップを
 * 少し動かしただけで、窓の端へ跳ばないようにする。
 *
 * 長さの下限は 0.5 秒。**今の長さが 0.5 秒未満なら今の長さを下限にする** (一覧で短くしたものを、
 * 帯で掴んだだけで勝手に伸ばさない)
 */
export function dragTelop(
  kind: TelopDragKind,
  startSec: number,
  endSec: number,
  deltaSec: number,
  window: TimeWindow,
): TelopSpan {
  if (!Number.isFinite(deltaSec)) {
    throw new RangeError(`動かした量が不正です: ${deltaSec}`);
  }
  // NaN もここで弾く (比較が偽になる)
  if (!(endSec > startSec)) {
    throw new RangeError(`テロップの終了が開始以下です: ${startSec}-${endSec}`);
  }
  const lowest = Math.min(window.startSec, startSec);
  const highest = Math.max(window.endSec, endSec);
  const length = endSec - startSec;
  const minLength = Math.min(MIN_TELOP_DRAG_SEC, length);

  if (kind === "move") {
    const next = clamp(startSec + deltaSec, lowest, highest - length);
    return { startSec: next, endSec: next + length };
  }
  if (kind === "start") {
    return { startSec: clamp(startSec + deltaSec, lowest, endSec - minLength), endSec };
  }
  return { startSec, endSec: clamp(endSec + deltaSec, startSec + minLength, highest) };
}

export type TelopTrackCallbacks = {
  /** ドラッグ中。動画をその位置へ追従させる (拡大バーの onScrub と同じ) */
  onScrub(sec: number): void;
  /** 指を離した。index のテロップの新しい時刻。**時刻が変わったときだけ**呼ぶ */
  onCommit(index: number, startSec: number, endSec: number): void;
  /** 押して動かさずに離した (4px 未満)。そのテロップの頭から再生する */
  onPlay(index: number): void;
};

export type TelopTrack = {
  element: HTMLElement;
  /**
   * テロップと、拡大バーの時間の窓を反映して描き直す。**テロップが 1 つも無ければ段ごと隠す**
   * (シンプルモードやテロップを使わない人のバーを高くしない)。ドラッグ中に呼ばれた分は、指を
   * 離してから描く (掴んでいる帯を作り直すと、ポインタの捕捉が外れる)
   */
  update(telops: Telop[], window: TimeWindow): void;
  /**
   * 動かせるか。偽の間は帯を薄く出し、掴んでも動かさず、押しても再生しない。**生成直後は偽**
   * (呼び出し側が忘れても、編集できない状態で動かさない)。進行中のドラッグは打ち切る
   */
  setEnabled(enabled: boolean): void;
  destroy(): void;
};

/** 帯に出す文言。空白と改行は 1 つの空白に詰める (帯は 1 行)。空なら「(未入力)」 */
function bandLabel(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? "(未入力)" : line;
}

export function createTelopTrack(callbacks: TelopTrackCallbacks): TelopTrack {
  const element = document.createElement("div");
  element.dataset.role = "telop-track";
  element.style.cssText = TELOP_TRACK_STYLE.root;

  // 左右に拡大バーの時刻のラベルと同じ文字を見えない形で置き、帯の段の箱を拡大バーのトラックと
  // 同じ左右に揃える (spec B.3)。幅を測って写す形にしないのは、ラベルの幅が変わるたび
  // (1:02:03 のような長い時刻) に測り直す経路が要るため
  const startGhost = document.createElement("span");
  startGhost.style.cssText = TELOP_TRACK_STYLE.ghost;
  const lanes = document.createElement("div");
  lanes.dataset.role = "telop-lanes";
  lanes.style.cssText = TELOP_TRACK_STYLE.lanes;
  const endCell = document.createElement("div");
  endCell.style.cssText = TELOP_TRACK_STYLE.endCell;
  const endGhost = document.createElement("span");
  endGhost.style.cssText = TELOP_TRACK_STYLE.ghost;
  // 2 段に入らない分の数。右端の時刻のラベルの下の余白に置き、帯と重ねない (spec B.3)。
  // 押しても何もしない (一覧で直す) ので、リスナは付けない
  const overflow = document.createElement("span");
  overflow.dataset.role = "telop-overflow";
  overflow.style.cssText = TELOP_TRACK_STYLE.overflow;
  overflow.hidden = true;
  endCell.append(endGhost, overflow);
  element.append(startGhost, lanes, endCell);

  let telops: Telop[] = [];
  let window_: TimeWindow = { startSec: 0, endSec: 0 };
  let enabled = false;
  /** 進行中のドラッグを打ち切る (帯を元に戻す)。ドラッグしていなければ null */
  let cancelDrag: (() => void) | null = null;
  /** ドラッグ中に届いた update。指を離してから取り込む */
  let pending: { telops: Telop[]; window: TimeWindow } | null = null;
  /** 間引き用。次の描画フレームまで scrub をまとめる (range-bar.ts と同じ) */
  let scrubFrame = 0;
  let pendingScrubSec: number | null = null;

  function takePending(): void {
    if (pending === null) return;
    telops = pending.telops;
    window_ = pending.window;
    pending = null;
  }

  function placeBand(band: HTMLElement, span: TelopSpan): void {
    const left = timeToRatio(span.startSec, window_);
    const right = timeToRatio(span.endSec, window_);
    band.style.left = `${left * 100}%`;
    band.style.width = `${(right - left) * 100}%`;
  }

  /** ドラッグ中の追従。毎フレーム 1 回に間引く */
  function requestScrub(sec: number): void {
    pendingScrubSec = sec;
    if (scrubFrame !== 0) return;
    scrubFrame = requestAnimationFrame(() => {
      scrubFrame = 0;
      if (pendingScrubSec === null) return;
      const target = pendingScrubSec;
      pendingScrubSec = null;
      // 予約した後に無効になっている (録画が始まった) ことがある。シークすると録画に飛びが入る
      if (!enabled) return;
      callbacks.onScrub(target);
    });
  }

  function beginDrag(band: HTMLElement, index: number, event: PointerEvent): void {
    // 無効な間 (preview・録画中) は動かさず、再生もしない (一覧の ▶ も押せない)。
    // 主ボタン以外 (右クリックのメニューなど) では動かさない
    if (!enabled || event.button !== 0 || cancelDrag !== null) return;
    const telop = telops[index];
    if (telop === undefined) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();

    const box = band.getBoundingClientRect();
    const kind = grabKindAt(event.clientX - box.left, box.width);
    // このドラッグを起こした指だけを追う (floating-window.ts と同じ)
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin: TelopSpan = { startSec: telop.startSec, endSec: telop.endSec };
    let current: TelopSpan = origin;
    /** 4px 以上動いたか。一度動いたら、元の場所へ戻してもクリックには戻さない */
    let moved = false;
    band.setPointerCapture(pointerId);

    const finish = (): void => {
      // リスナを外してから捕捉を解く。先に解くと、自分の lostpointercapture で settle が 2 度走る
      band.removeEventListener("pointermove", onMove);
      band.removeEventListener("pointerup", onUp);
      band.removeEventListener("pointercancel", onCancel);
      band.removeEventListener("lostpointercapture", onCancel);
      band.releasePointerCapture(pointerId);
      // 予約済みのシークも取り消す。残すと指を離した 1 フレーム後に動画が飛ぶ (元の位置へ戻して
      // 離した・打ち切ったときでも、見た目と違う位置へシークしてしまう)
      if (scrubFrame !== 0) cancelAnimationFrame(scrubFrame);
      scrubFrame = 0;
      pendingScrubSec = null;
      cancelDrag = null;
    };

    /** 指を離した (または取り上げられた)。時刻が変わっていれば確定する */
    const settle = (canPlay: boolean): void => {
      finish();
      const changed =
        current.startSec !== origin.startSec || current.endSec !== origin.endSec;
      takePending();
      // 掴んだ後に届いた update でテロップが消えた・入れ替わった (index がずれた) ときは確定も
      // 再生もしない。掴んだ時点の時刻のテロップが同じ index にあることで、同じテロップと見なす。
      // 確かめないと、別のテロップに時刻を載せて送ってしまう
      const target = telops[index];
      const sameTarget =
        target !== undefined &&
        target.startSec === origin.startSec &&
        target.endSec === origin.endSec;
      const commit = changed && sameTarget;
      if (commit) {
        // 状態の通知が返るまでの間も、離した場所に帯を残す (次の通知で同じ時刻が届く)
        telops = telops.map((item, position) =>
          position === index ? { ...item, ...current } : item,
        );
      }
      paint();
      if (commit) {
        callbacks.onCommit(index, current.startSec, current.endSec);
      } else if (!moved && canPlay && sameTarget) {
        callbacks.onPlay(index);
      }
    };

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      // 4px に届くまでは動かさない (押して離すクリックと見分ける。spec B.2)
      if (!moved && Math.hypot(dx, dy) < TELOP_CLICK_SLOP_PX) return;
      moved = true;
      const width = lanes.getBoundingClientRect().width;
      // 幅が 0 (隠れた直後など) なら秒に直せない。動かさない。
      // 先に掛けてから割る (割ってから掛けるより丸めの誤差が出にくい)
      const deltaSec =
        width <= 0 ? 0 : (dx * (window_.endSec - window_.startSec)) / width;
      current = dragTelop(kind, origin.startSec, origin.endSec, deltaSec, window_);
      placeBand(band, current);
      // 動かしている側の位置を見せる。中を掴んだときは開始 (拡大バーの「動かしている側」と同じ)
      requestScrub(kind === "end" ? current.endSec : current.startSec);
    };

    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) return;
      settle(true);
    };

    // pointercancel (タッチの横取りなど)・lostpointercapture でも終える。動かした分は確定する
    // (range-bar.ts・floating-window.ts と同じ)。押しただけなら再生しない (取り上げられた操作を
    // クリックとみなさない)
    const onCancel = (cancelled: Event): void => {
      const cancelledId = (cancelled as PointerEvent).pointerId;
      if (cancelledId !== undefined && cancelledId !== pointerId) return;
      settle(false);
    };

    cancelDrag = (): void => {
      finish();
      takePending();
      // 元の位置 (または届いていた update の位置) で描き直す。送らない
      paint();
    };

    band.addEventListener("pointermove", onMove);
    band.addEventListener("pointerup", onUp);
    band.addEventListener("pointercancel", onCancel);
    band.addEventListener("lostpointercapture", onCancel);
  }

  function makeBand(index: number, telop: Telop, lane: number): HTMLElement {
    const band = document.createElement("div");
    band.dataset.role = "telop-band";
    band.dataset.index = String(index);
    band.dataset.lane = String(lane);
    band.style.cssText = TELOP_TRACK_STYLE.band;
    band.style.top = `${lane * (TELOP_LANE_HEIGHT_PX + TELOP_LANE_GAP_PX)}px`;
    band.textContent = bandLabel(telop.text);
    // 帯は 1 行で省略する。時刻と全文はマウスを乗せたときに読めるようにする
    band.title = `${formatTime(telop.startSec)} 〜 ${formatTime(telop.endSec)}\n${
      telop.text.trim() === "" ? "(未入力)" : telop.text
    }`;
    placeBand(band, telop);
    // 押す前から、端と中で違うカーソルを出す (掴んだら何が動くかを先に見せる)
    band.addEventListener("pointermove", (event: PointerEvent) => {
      if (cancelDrag !== null) return;
      const box = band.getBoundingClientRect();
      band.style.cursor =
        grabKindAt(event.clientX - box.left, box.width) === "move" ? "grab" : "ew-resize";
    });
    band.addEventListener("pointerdown", (event: PointerEvent) => beginDrag(band, index, event));
    return band;
  }

  function paint(): void {
    // 出し入れは hidden と style.display の両方で行う。根は flex で並べるので display を持ち、
    // inline の display は UA の [hidden] に勝つ (floating-window.ts と同じ作法)
    const shown = telops.length > 0;
    element.hidden = !shown;
    element.style.display = shown ? "flex" : "none";
    startGhost.textContent = formatTime(window_.startSec);
    endGhost.textContent = formatTime(window_.endSec);

    const entries = telopsInWindow(telops, window_).flatMap((index) => {
      const telop = telops[index];
      return telop === undefined ? [] : [{ index, telop }];
    });
    const laneOf = assignLanes(
      entries.map((entry) => entry.telop),
      MAX_TELOP_LANES,
    );
    const bands: HTMLElement[] = [];
    let overflowCount = 0;
    entries.forEach(({ index, telop }, position) => {
      const lane = laneOf[position] ?? -1;
      if (lane < 0) {
        overflowCount += 1;
        return;
      }
      bands.push(makeBand(index, telop, lane));
    });
    lanes.replaceChildren(...bands);
    overflow.hidden = overflowCount === 0;
    overflow.textContent = overflowCount === 0 ? "" : `+${overflowCount}`;
    overflow.title =
      overflowCount === 0
        ? ""
        : `ほかに ${overflowCount} 件 (時間が重なって帯に出せないテロップ。一覧で直す)`;
  }

  function applyEnabled(): void {
    element.style.opacity = enabled ? "" : "0.4";
    lanes.style.pointerEvents = enabled ? "" : "none";
  }

  applyEnabled();
  paint();

  return {
    element,

    update(nextTelops: Telop[], nextWindow: TimeWindow): void {
      if (cancelDrag !== null) {
        pending = { telops: nextTelops, window: nextWindow };
        return;
      }
      telops = nextTelops;
      window_ = nextWindow;
      paint();
    },

    setEnabled(next: boolean): void {
      enabled = next;
      applyEnabled();
      // 録画が始まったら進行中のドラッグも打ち切る。捕捉中は pointer-events を切ってもイベントが
      // 届くので、切るだけでは止まらない (range-bar.ts と同じ理由)
      if (!next) cancelDrag?.();
    },

    destroy(): void {
      cancelDrag?.();
      if (scrubFrame !== 0) cancelAnimationFrame(scrubFrame);
      element.remove();
    },
  };
}
