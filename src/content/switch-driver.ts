import { loadEnabled, watchEnabled } from "@/shared/master-switch";

/**
 * content script のオン / オフ (マスタースイッチの spec `.claude/specs/2026-09-25-master-switch-design.md` §2.1)。
 * 保存された値を 1 回読み、chrome.storage.onChanged を見張り、**望んでいる状態 (desired) と走っている状態 (running) を
 * reconcile() で合わせる**。youtube.ts と x.ts が同じ作法で使う。
 *
 * **chrome.storage にだけ触る (DOM に触らない)。** オフのページに残るのは、この読み 1 回と onChanged の listener 1 本だけ
 * (spec §1 の「残るもの」。拡張の隔離された world の中で完結し、ページからは見えない)
 */

export type SwitchHooks = {
  start(): void;
  stop(): void;
  /**
   * 今 stop してよいか。偽なら stop を待つ。省くと常に真。
   * youtube.ts は**このタブで録画の準備・録画・書き出しが走っている間**だけ偽 (spec §4.1)。状態機械の busy ではない
   */
  canStop?(): boolean;
  /** stop を待たされた (canStop が偽)。youtube.ts はここで中止を送る (spec §4.1)。待ちに入るたびに 1 回 */
  onStopDeferred?(): void;
};

export type SwitchDriver = {
  /**
   * desired と running を比べ、違えば start / stop を呼ぶ。stop は canStop() が真のときだけ。最初の読みと onChanged で
   * 自分で呼ぶほか、**呼び出し側が「stop してよくなった」ときにも呼ぶ** (youtube.ts は状態の通知の処理の末尾と、
   * 中止の応答・録画の結末を送り終えたとき)
   */
  reconcile(): void;
  /** onChanged の見張りを外す。走っているものは止めない (content script はページと一緒に消えるので、使うのはテスト) */
  destroy(): void;
};

export function createSwitchDriver(hooks: SwitchHooks): SwitchDriver {
  /** 望んでいる状態。最初の読みか onChanged が来るまでは null (まだ何もしない) */
  let desired: boolean | null = null;
  let running = false;
  /**
   * stop を待たせていて、onStopDeferred を知らせた後か。**待ちに入るたびに 1 回だけ知らせる**: reconcile は状態の通知の
   * たびに呼ばれるので、そのたびに中止を送り直させない。stop した・オンに戻ったら下ろす
   */
  let deferred = false;
  let destroyed = false;

  function reconcile(): void {
    if (destroyed || desired === null) return;
    if (desired) {
      // オンに戻った。待たせていた stop は要らない
      deferred = false;
      if (running) return;
      // 先に立てる: start の中から reconcile が呼ばれても二度 start しない
      running = true;
      hooks.start();
      return;
    }
    if (!running) return;
    if (hooks.canStop !== undefined && !hooks.canStop()) {
      if (!deferred) {
        deferred = true;
        hooks.onStopDeferred?.();
      }
      return;
    }
    deferred = false;
    running = false;
    hooks.stop();
  }

  const unwatch = watchEnabled((enabled) => {
    desired = enabled;
    reconcile();
  });

  void loadEnabled().then((enabled) => {
    // 読みが返る前に onChanged が来ていたら、そちらが新しい (読みは書き換わる前の値を返しうる)。最後の値だけを効かせる
    if (desired !== null) return;
    desired = enabled;
    reconcile();
  });

  return {
    reconcile,
    destroy(): void {
      destroyed = true;
      unwatch();
    },
  };
}
