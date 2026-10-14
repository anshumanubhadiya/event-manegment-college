/**
 * clock.ts — time ka source. Demo mode me virtual clock (tez), live me asli time.
 *
 * Poora engine `clock.now()` use karta hai — isliye demo me poora trading din
 * kuch minute me replay ho jaata hai, aur baaki code ko farak nahi padta.
 */

import { sleep } from "../util.ts";

export interface Clock {
  now(): number;
  /** Sirf virtual clock ke liye. Real clock me no-op. */
  advance?(ms: number): void;
  isVirtual(): boolean;
  /** Real seconds me kitna wait karna hai jab tak virtual time X na ho jaye (n/a = 0). */
  msUntil(virtualTs: number): number;
  speed(): number;
}

/** Asli time. */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  isVirtual(): boolean {
    return false;
  }
  msUntil(): number {
    return 0;
  }
  speed(): number {
    return 1;
  }
}

/**
 * Virtual clock — demo/backtest ke liye.
 * speed = 60 matlab 1 asli second = 60 virtual second (poora session ~6 min).
 */
export class VirtualClock implements Clock {
  private virtualNow: number;
  private anchorReal: number;
  private readonly _speed: number;
  private readonly stepMode: boolean;

  /**
   * @param speed    kitna tez (60 = 60x)
   * @param stepMode true = clock sirf advance() se chalta hai (demo feed drive karta hai).
   *                 Isse candles, entry window aur "abhi kitna baja hai" sab EK hi
   *                 time pe rehta hai — warna feed aur clock drift kar jaate hain.
   */
  constructor(startTs: number, speed: number, stepMode = false) {
    this.virtualNow = startTs;
    this.anchorReal = Date.now();
    this._speed = Math.max(speed, 1);
    this.stepMode = stepMode;
  }

  now(): number {
    if (this.stepMode) return this.virtualNow;
    const realElapsed = Date.now() - this.anchorReal;
    return this.virtualNow + realElapsed * this._speed;
  }

  advance(ms: number): void {
    this.virtualNow = this.now() + ms;
    this.anchorReal = Date.now();
  }

  isVirtual(): boolean {
    return true;
  }

  msUntil(virtualTs: number): number {
    const deltaVirtual = virtualTs - this.now();
    return deltaVirtual <= 0 ? 0 : deltaVirtual / this._speed;
  }

  speed(): number {
    return this._speed;
  }

  /** Real time me itna rukо jitne me virtual clock target tak pahunche. */
  async waitUntil(virtualTs: number): Promise<void> {
    const ms = this.msUntil(virtualTs);
    if (ms > 0) await sleep(Math.min(ms, 60_000));
  }
}
