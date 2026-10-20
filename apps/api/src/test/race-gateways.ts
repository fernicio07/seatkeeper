import { randomUUID } from 'node:crypto';
import type { ChargeResult, PaymentGateway } from '../services/interfaces';

/**
 * Holds every charge() until `parties` calls have arrived, then lets them all
 * through. Forces the worst-case interleaving deterministically: every caller
 * is provably past the service's dry run before any of them can write.
 */
export class BarrierGateway implements PaymentGateway {
  private waiting: Array<() => void> = [];
  constructor(private inner: PaymentGateway, private parties = 2) {}

  async charge(params: { amount: number; idempotencyKey: string }): Promise<ChargeResult> {
    await new Promise<void>((release) => {
      this.waiting.push(release);
      if (this.waiting.length >= this.parties) this.waiting.splice(0).forEach((r) => r());
    });
    return this.inner.charge(params);
  }
}

/** A gateway that IGNORES idempotency keys — to show which layer stops which failure. */
export class NaiveGateway implements PaymentGateway {
  chargeCount = 0;
  async charge(): Promise<ChargeResult> {
    this.chargeCount++;
    return { status: 'succeeded', chargeId: `ch_${randomUUID()}` };
  }
}
