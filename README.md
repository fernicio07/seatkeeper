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
npm run dev -w @seatkeeper/api   # API on http://localhost:4000
./scripts/demo-api.sh            # walks price change, expiry, double-complete via curl
npm test                         # Jest across workspaces
npm run typecheck
```

## API

| Route | Purpose |
|---|---|
| `POST /checkout` `{listingId}` | Create session, take inventory hold → 201 |
| `GET /checkout/:id` | Resume: evaluate (expiry, price, hold) + persist, return fresh session |
| `POST /checkout/:id/pay` `{expectedVersion, acceptedPrice}` | ACTIVE → PENDING_PAYMENT |
| `POST /checkout/:id/complete` `{expectedVersion, idempotencyKey}` | Charge, → COMPLETED / FAILED |

Every response, success or error, includes the current `session` so a client can always re-render
from server truth. Errors: 404 not found · 409 `VERSION_CONFLICT` / `PRICE_MISMATCH` /
`INVALID_TRANSITION` · 410 `SESSION_EXPIRED` · 422 `IDEMPOTENCY_KEY_MISMATCH` · 400 bad body.

Dev-only levers (not registered in production): `POST /dev/listings/:id/price`,
`/dev/clock/advance`, `/dev/payments/next-outcome`, `/dev/holds/:holdId/revoke`.

### Layers
- `domain/checkout-machine.ts` — pure `evaluate()` / `transition()`: decides.
- `domain/checkout-service.ts` — imperative shell: gathers facts, calls the machine, persists with
  CAS, runs side effects (hold release, charge, analytics) only after a successful write.
- `app.ts` — HTTP adapter: JSON-schema validation, error-code → status mapping. No rules.

**Charge safety:** `complete` dry-runs the transition with a hypothetical success *before*
calling the gateway, so we never charge for a session that is ACTIVE, expired, stale, or already
completed. The gateway call itself is keyed by the session's `idempotencyKey`.

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
