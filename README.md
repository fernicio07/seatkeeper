# Seatkeeper — checkout continuity prototype

A fan starts checkout on web and resumes it on a (simulated) mobile surface —
without duplicate orders, stale inventory, or silently changed prices.

> 🚧 Built incrementally; sections fill in as each step lands.

## Layout

```
packages/shared   Types shared by API and clients (CheckoutSession, events, errors)
apps/api          Node + TypeScript backend: state machine, store, stub services
apps/web          (step 3) Next.js web checkout + simulated mobile route
```

## Running

```bash
npm install
npm test          # Jest across workspaces
npm run typecheck
```

## Session state model

`ACTIVE → PENDING_PAYMENT → COMPLETED`, plus terminal `EXPIRED` and `FAILED`.
`PRICE_CHANGED` is a **derived signal** (`currentPrice !== priceAtStart`), not a status.

| From | Event | To | Guard |
|---|---|---|---|
| ACTIVE | PAY | PENDING_PAYMENT | not expired, hold valid, `expectedVersion` matches, `acceptedPrice === currentPrice` |
| ACTIVE | time | EXPIRED | `now >= expiresAt` (evaluated lazily on every read/write) |
| PENDING_PAYMENT | COMPLETE (ok) | COMPLETED | `idempotencyKey` matches |
| PENDING_PAYMENT | COMPLETE (declined) | FAILED | — |
| PENDING_PAYMENT | PAY | PENDING_PAYMENT | idempotent no-op — only if `acceptedPrice === currentPrice` |
| COMPLETED | COMPLETE | COMPLETED | idempotent replay (same `idempotencyKey`) |

Guard order in `transition()`: **replays first, then the version check, then per-event guards.**
A retry carries the version the client saw *before* its first attempt succeeded, so checking the
version first would turn every legitimate retry into a conflict. Replays change nothing, so
skipping the version check for them can't cause a lost update.

ACTIVE sessions whose inventory hold is no longer valid (seat sold elsewhere) also become EXPIRED.

Expiry does not apply in PENDING_PAYMENT: once a charge is in flight the hold is frozen.

### Concurrency
Optimistic concurrency: every write is `compareAndSet(id, expectedVersion, next)`;
the store bumps `version`. Losers get the fresh session back (→ HTTP 409), which
doubles as the cross-surface UX signal. External side effects (charges) are
additionally deduped by the per-session `idempotencyKey`.

## Tradeoffs / more time
- Hold-lost and timed-out both surface as EXPIRED; an `expiryReason` would let the client offer
  "pick another seat" vs "restart this seat".
_(more as steps land)_
