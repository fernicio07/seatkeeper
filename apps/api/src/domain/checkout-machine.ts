import type {
  CheckoutEvent,
  CheckoutSession,
  EvaluationContext,
  TransitionResult,
} from '@seatkeeper/shared';

export function evaluate(session: CheckoutSession, ctx: EvaluationContext): CheckoutSession {
  if (
    session.status === 'COMPLETED' ||
    session.status === 'EXPIRED' ||
    session.status === 'FAILED'
  ) {
    return { ...session };
  }

  // Once PENDING_PAYMENT, hold is frozen; expiry does not apply.
  if (session.status === 'PENDING_PAYMENT') {
    return { ...session };
  }

  // ACTIVE state evaluation
  if (ctx.now >= session.expiresAt || !ctx.holdValid) {
    return {
      ...session,
      status: 'EXPIRED',
    };
  }

  // Refresh currentPrice if changed while ACTIVE
  if (session.currentPrice !== ctx.currentPrice) {
    return {
      ...session,
      currentPrice: ctx.currentPrice,
    };
  }

  return { ...session };
}

export function transition(session: CheckoutSession, event: CheckoutEvent): TransitionResult {
  // 1. Idempotent replays checked FIRST. Replays carry out-of-date expected versions
  // by definition (the first attempt already bumped it), so version checks don't apply here.
  if (event.type === 'COMPLETE') {
    if (event.idempotencyKey !== session.idempotencyKey) {
      return {
        ok: false,
        error: 'IDEMPOTENCY_KEY_MISMATCH',
        session: { ...session },
      };
    }
    if (session.status === 'COMPLETED') {
      return {
        ok: true,
        session: { ...session },
      };
    }
  }

  if (event.type === 'PAY' && session.status === 'PENDING_PAYMENT') {
    // Even on re-PAY, guard against silent price changes (e.g. out-of-date web tab retrying)
    if (event.acceptedPrice !== session.currentPrice) {
      return {
        ok: false,
        error: 'PRICE_MISMATCH',
        session: { ...session },
      };
    }
    return {
      ok: true,
      session: { ...session },
    };
  }

  // 2. Snapshot version check against client expected version for all actual mutations
  if (session.version !== event.expectedVersion) {
    return {
      ok: false,
      error: 'VERSION_CONFLICT',
      session: { ...session },
    };
  }

  // 3. Event-specific handling
  if (event.type === 'PAY') {
    if (
      session.status === 'EXPIRED' ||
      session.status === 'FAILED' ||
      session.status === 'COMPLETED'
    ) {
      const error = session.status === 'EXPIRED' ? 'SESSION_EXPIRED' : 'INVALID_TRANSITION';
      return {
        ok: false,
        error,
        session: { ...session },
      };
    }

    if (event.acceptedPrice !== session.currentPrice) {
      return {
        ok: false,
        error: 'PRICE_MISMATCH',
        session: { ...session },
      };
    }

    return {
      ok: true,
      session: {
        ...session,
        status: 'PENDING_PAYMENT',
      },
    };
  }

  if (event.type === 'COMPLETE') {
    if (session.status !== 'PENDING_PAYMENT') {
      return {
        ok: false,
        error: 'INVALID_TRANSITION',
        session: { ...session },
      };
    }

    const nextStatus = event.chargeOutcome === 'succeeded' ? 'COMPLETED' : 'FAILED';
    return {
      ok: true,
      session: {
        ...session,
        status: nextStatus,
      },
    };
  }

  const _exhaustive: never = event;
  return {
    ok: false,
    error: 'INVALID_TRANSITION',
    session: { ...session },
  };
}
