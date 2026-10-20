# Seatkeeper — checkout continuity prototype

A fan starts checkout on web and resumes it on a (simulated) mobile surface —
without duplicate orders, stale inventory, or silently changed prices.

> 🚧 Built incrementally; sections fill in as each step lands.

## Layout

```
packages/shared   Types shared by API and clients (CheckoutSession, events, errors)
apps/api          Node + TypeScript backend: state machine, store, stub services
apps/web          Next.js (App Router): web checkout, simulated mobile route, side-by-side demo
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
| `POST /checkout` `{listingId}` | Create session, take an exclusive inventory hold → 201 (409 `SEAT_UNAVAILABLE` if held/sold) |
| `GET /checkout/:id?surface=web\|mobile` | Resume: evaluate (expiry, price, hold) + persist, return fresh session |
| `POST /checkout/:id/pay` `{expectedVersion, acceptedPrice}` | ACTIVE → PENDING_PAYMENT (freezes the hold) |
| `POST /checkout/:id/complete` `{expectedVersion, idempotencyKey, acceptedPrice}` | Charge, → COMPLETED (confirms the sale) / FAILED (releases) |
| `GET /listings/:id` | Listing + `available` (helper for the landing page) |
| `POST /events` | Whitelisted client analytics events → 204 |

Every response, success or error, includes the current `session` so a client can always re-render
from server truth. Errors: 404 not found · 409 `VERSION_CONFLICT` / `PRICE_MISMATCH` /
`INVALID_TRANSITION` / `SEAT_UNAVAILABLE` · 410 `SESSION_EXPIRED` · 422 `IDEMPOTENCY_KEY_MISMATCH` ·
503 `BUSY` (write contention after retries; still carries the last stored session) · 400 bad body.

Dev-only levers (not registered in production): `POST /dev/listings/:id/price`,
`/dev/clock/advance`, `/dev/payments/next-outcome`, `/dev/holds/:holdId/revoke`, `/dev/reset`
(seat back on sale; also a "Reset demo" link on the dev landing page).

### Inventory: exclusive holds with a lifecycle

One live hold or sale per seat (`hold()` returns null → `SEAT_UNAVAILABLE`).

`active (until session.expiresAt) → frozen (PENDING_PAYMENT) → sold (COMPLETED)`, or `→ released`
(EXPIRED / FAILED / revoked).

The hold mirrors the session's deadline instead of having no expiry of its own. Session expiry is
lazy, so without that an abandoned checkout would lock the seat until someone happened to re-load
that session: stale inventory in the other direction. Leaving a checkout doesn't release the seat
early; the hold frees it at `expiresAt` (accepted tradeoff, no CANCELLED state).

Side effects (freeze / confirm / release / analytics) run after a committed write and are
best-effort: a failure is logged, never turned into a 500 for an operation that succeeded.
Production: an outbox with retries.

### Analytics
Server: `checkout_started`, `status_*`, `price_changed`, `surface_resumed` (with surface; only `reason=open`, so focus/countdown refreshes don't inflate it),
`checkout_replayed`. Client (via `POST /events`): `price_banner_shown` (once per distinct change,
guarded against Strict Mode double effects), `price_banner_acknowledged`.

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

## Cross-surface resume (web → mobile)

- **The deep link carries only the session id** (`/mobile/checkout/<id>`), never price, version, or
  status. A link is a frozen snapshot that may be opened hours later; carrying only the id forces
  the opening surface to resume through `GET /checkout/:id`, where the server re-validates.
- **`/mobile/checkout/[id]`**: the simulated mobile surface. Same SSR resume, its own client state,
  phone-frame layout (full-screen on real phone widths).
- **`/demo/[id]`**: web and mobile side by side as two iframes: separate documents and React roots
  that share nothing but the id. An honest two-device simulation, used for the duplicate-completion
  demo.
- **Re-validate on return**: each surface re-fetches on `visibilitychange`/`focus`, because while
  it was backgrounded the other surface may have paid or the price may have moved. Concurrent
  triggers share one in-flight request (a tab switch fires both events).
- **Production gap:** possession of the id is enough to act on the session. Real handoff would use
  a short-lived, single-use token bound to the fan's account.

## Price change & expiry UX

**The screen is a pure function:** `view = deriveCheckoutView(session, acceptedPrice)`
(`packages/shared`). Error codes are only transient messages; a 409 still carries the fresh
session, and re-deriving from it shows the right screen.

**`acceptedPrice`** is per-surface client state: the price this fan has agreed to *here*. It starts
at `priceAtStart` (what the fan committed to when checkout began, not "what this surface last
showed", which would let mobile display a bumped price with no explanation). Acknowledging sets it
to the exact price printed on the button pressed. `pay` sends it, so the UI gate and the server's
`PRICE_MISMATCH` guard enforce the same rule at two layers.

| Precedence | Condition | Screen |
|---|---|---|
| 1 | COMPLETED | Confirmation |
| 2 | FAILED | Declined + restart |
| 3 | EXPIRED | "Your hold ended" + one-tap restart (new session, same surface, today's price) |
| 4 | ACTIVE or PENDING_PAYMENT, `currentPrice !== acceptedPrice` | **Blocking price banner** |
| 5 | PENDING_PAYMENT | Place order |
| 6 | ACTIVE | Pay + countdown |

**Why the banner blocks:** consent to the exact amount (live-event ticketing is under specific
all-in-pricing rules); a toast can be missed while the old CTA is still tappable; the server
rejects a mismatch anyway, so a gate beats an after-the-click error. The banner *replaces* the pay
button, so blocking is structural. It blocks on decreases too (positive copy). Focus moves to it.

**Rule 4 covers PENDING_PAYMENT** so a stale surface can't show "Place order · $210" when the fan
agreed to $210 only on the *other* device. (A matching server guard on `complete` lands in step 7.)

**Expiry:** at local zero the UI shows "Confirming your hold…" and asks the server, which decides.
Recovery is a Server Action form, so it works before hydration.

## Duplicate completion (two surfaces, one session)

Two surfaces pressing "Place order" at the same time both load PENDING_PAYMENT v2, and both pass
the pre-charge dry run. Two independent layers then stop two different failures:

| Layer | Stops | How |
|---|---|---|
| `version` CAS | a second **order** (state write) | only one `compareAndSet(v2 → v3)` can win |
| `idempotencyKey` | a second **charge** | one key per session; the gateway returns the first result for a repeated key (Stripe semantics) |

The CAS loser doesn't fail. The service re-loads and re-runs `transition()` with the same event
(same charge result, so no new charge). The machine's replay-first guard sees COMPLETED with a
matching key and returns a replay. The losing surface gets **200 `replayed: true`** with the same
`orderId` and shows "Already purchased". `complete` also carries `acceptedPrice` (checked after
the replay check), so a stale surface can't complete at a price it never showed.

Tests force the worst case with a `BarrierGateway` that holds each charge until both requests
arrive. A `NaiveGateway` test (no key dedupe) shows the layering: still one order, but two charges.

## Session state model

`ACTIVE → PENDING_PAYMENT → COMPLETED`, plus terminal `EXPIRED` and `FAILED`.
`PRICE_CHANGED` is a **derived signal** (`currentPrice !== priceAtStart`), not a status.

| From | Event | To | Guard |
|---|---|---|---|
| ACTIVE | PAY | PENDING_PAYMENT | not expired, hold valid, `expectedVersion` matches, `acceptedPrice === currentPrice` |
| ACTIVE | time | EXPIRED | `now >= expiresAt` (evaluated lazily on every read/write) |
| PENDING_PAYMENT | COMPLETE (ok) | COMPLETED | `idempotencyKey` matches, `acceptedPrice === currentPrice`; sets `orderId` |
| PENDING_PAYMENT | COMPLETE (declined) | FAILED | — |
| PENDING_PAYMENT | PAY | PENDING_PAYMENT | idempotent no-op — only if `acceptedPrice === currentPrice` |
| COMPLETED | COMPLETE | COMPLETED | idempotent replay (same `idempotencyKey`) |

Guard order in `transition()`: **replays first, then the version check, then per-event guards.**
A retry carries the version the client saw *before* its first attempt succeeded, so checking the
version first would turn every legitimate retry into a conflict. Replays change nothing, so
skipping the version check for them can't cause a lost update.

ACTIVE sessions whose inventory hold is no longer valid (seat sold elsewhere) also become EXPIRED.

Expiry does not apply in PENDING_PAYMENT: once a charge is in flight the hold is frozen. If the hold is
nonetheless lost (revoked), `evaluate()` moves the session to FAILED *before* any charge.

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
- Handoff is a plain link; production would use QR / push / universal links + a signed handoff token.
- Event time zone is pinned to Eastern; real listings would carry `venueTimeZone`.
- Acknowledgment is per-surface and not persisted: accepting on web means mobile asks again, and
  a reload asks again. Errs toward over-asking; a server-side ack would sync it at the cost of a route.
- No push: a price change is discovered at the next interaction (refocus, countdown, action), never
  by a silent charge. SSE would surface it live.
- Double-charge protection relies on the gateway honoring idempotency keys. The alternative, a
  claim-before-charge `PROCESSING` state, means only one request ever reaches the gateway, but it
  needs crash recovery (reconcile a stuck claim with the gateway by key). Not worth it at this scope.
- `orderId` is the charge id. Real systems separate orders from payments (one order can have
  retries/refunds).
_(more as steps land)_
