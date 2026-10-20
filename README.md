# Seatkeeper — checkout continuity prototype

A fan starts checkout on web and resumes it on a (simulated) mobile surface —
without duplicate orders, stale inventory, or silently changed prices.

> 🚧 Built incrementally; sections fill in as each step lands.

## Layout

```
packages/shared   Types shared by API and clients (CheckoutSession, events, errors)
apps/api          Node + TypeScript backend: state machine, store, stub services
apps/web          Next.js (App Router) web checkout; simulated mobile route in step 4
```

## Running

```bash
npm install
npm run dev                      # API on :4000 + web on http://localhost:3000
                                 # (or individually: npm run dev -w @seatkeeper/api | web)
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

## Web: SSR first, then hydrate

`/checkout/[id]` is a Server Component. On every request it resumes the session server-side
(`GET /checkout/:id`, `cache: 'no-store'`, so the API re-validates expiry, price, and hold) and
renders event, seat, price **and the starting countdown** into the HTML. The fan sees a complete,
correct screen before any JS runs.

- **`EventHeader`**: Server Component, ships zero JS (event/seat never change).
- **`CheckoutPanel`**: client island. Also server-rendered for first paint, then hydrated. It
  only ever replaces its copy of the session with what the API returns; it never derives state.
- **Hydration-safe countdown**: the first render uses only props (`expiresAt - serverTime`), so
  server and client produce the same string. Ticking starts in `useEffect`. It is anchored to the
  **API's clock** (`serverTime` in every response), not the browser's, so a skewed laptop clock
  (or the dev fast-forward) doesn't lie. At zero it asks the server, which decides.
- **Pinned formatting**: `Intl` formatters pin `en-US` / `America/New_York` (venue time). Default
  locale/zone differ between Node and the browser and would cause hydration mismatches.
- **Buttons render disabled until hydration** (honest about not being interactive yet).

**See it:** `curl localhost:3000/checkout/<id>` shows full content in raw HTML; the badge under
the button shows "Server-rendered · hydrating…" in that HTML and switches to
"Interactive · hydrated Nms after navigation" in the browser. Disable JS in DevTools and the
screen still renders correctly (frozen countdown, inert buttons).

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
- Interactive actions need JS. A no-JS path could use Server Action forms (React 19 even replays
  submissions made before hydration); skipped for scope.
- Countdown residual error ≈ time from API response to hydration (errs generous); server is the authority.
_(more as steps land)_
