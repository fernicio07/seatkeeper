# Seatkeeper: checkout continuity prototype

A fan starts checkout on web and resumes it on a (simulated) mobile surface, **without duplicate
orders, stale inventory, or silently changed prices**.

The backend owns a `CheckoutSession` as the single source of truth. Clients hold only the session
id and re-validate on every resume. The slice covers three state changes end to end:

1. **Expiration**: resume after `expiresAt` → EXPIRED, with a one-tap recovery.
2. **Price change**: the server bumps `currentPrice` → a blocking banner the fan must acknowledge;
   the server refuses any charge at a price the client didn't send.
3. **Duplicate completion**: two surfaces complete the same session → one order, one charge; the
   second surface sees "Already purchased" with the same order number.

Stack: Node + TypeScript + Fastify (in-memory store), Next.js 16 App Router, Jest. Payment,
inventory, and analytics are stubs behind `PaymentGateway`, `InventoryService`, `AnalyticsSink`.

```
packages/shared   Types + the pure view derivation shared by API and clients
apps/api          State machine, CheckoutService, Fastify routes, in-memory store, stubs
apps/web          SSR web checkout, simulated mobile route, side-by-side demo
scripts/          demo-api.sh: curl walkthrough of every scenario
```

## Quick start

Requires Node 22+ (developed on Node 26).

```bash
npm install
npm run dev              # API on http://localhost:4000, web on http://localhost:3000
npm test                 # 77 API + 12 shared tests
npm run coverage         # per-file coverage
npm run typecheck
./scripts/demo-api.sh    # every scenario over HTTP, with the API running
```

## Try it in the browser

Open http://localhost:3000 and press **Start checkout**. Dev-only levers drive the scenarios:

```bash
curl -s -X POST localhost:4000/dev/listings/lst_heat_1/price -H 'content-type: application/json' -d '{"price":21000}'   # bump price
curl -s -X POST localhost:4000/dev/clock/advance        -H 'content-type: application/json' -d '{"ms":300000}'     # skip 5 min
curl -s -X POST localhost:4000/dev/reset                -H 'content-type: application/json' -d '{}'                # seat back on sale
```

Completing a purchase really sells the seat. Use **Reset demo** on the landing page (or
`/dev/reset`) between runs.

1. **SSR before hydration.** `curl localhost:3000/checkout/<id>` returns event, seat, price and the
   starting countdown in raw HTML. The badge under the button reads "Server-rendered · hydrating…"
   in that HTML and "Interactive · hydrated Nms after navigation" in the browser. With JS
   disabled, the screen still renders (frozen countdown, inert buttons).
2. **Cross-surface resume.** Click **📱 Continue on your phone**. `/mobile/checkout/<id>` opens in
   a phone frame, resumes the same session from the server, and shows the same countdown (both are
   anchored to the API clock).
3. **Price change.** With a checkout open, bump the price, then return to the tab (or press
   Continue to payment). The pay button is replaced by a banner: ~~$185.00~~ → **$210.00**. Nothing
   proceeds until **Continue at $210.00**.
4. **Expiry and recovery.** Skip 5 minutes, then return to the tab. The screen becomes "Your hold on
   this seat ended". **Check availability again** creates a new session on the same surface.
5. **Two fans, one seat.** With a checkout active, open the landing page in another tab: it shows
   **Seat unavailable**.
6. **Duplicate completion.** Open **Side-by-side demo** (link under the checkout card) and get both
   surfaces to *Place order*: press Continue to payment on one, then click into the other.
   - **By hand:** place the order on web, then click into mobile. Mobile re-validates on focus and
     converges to "Order confirmed" with the **same order id**. It never offers a second Place
     order. This is the first line of defense.
   - **The race:** press **⚡ Race both surfaces** (dev-only toolbar). Both requests land in the same
     window: web shows "Order confirmed", mobile shows **"Already purchased… You were charged once."**
     Same order id. This is the second line of defense, idempotent replay.

## Session state model

```
                 PAY (fresh version, acceptedPrice === currentPrice)
   ACTIVE ─────────────────────────────────────────────▶ PENDING_PAYMENT
     │  now ≥ expiresAt, or hold lost                     │      │      │
     ▼                                         charge ok  │      │      │ hold lost (before charge)
   EXPIRED                                                ▼      │      ▼
                                                    COMPLETED    │    FAILED
                                                                 └──▶ FAILED (charge declined)
```

| From | Event | To | Guard |
|---|---|---|---|
| ACTIVE | PAY | PENDING_PAYMENT | `expectedVersion` current, `acceptedPrice === currentPrice` |
| ACTIVE | time / hold lost | EXPIRED | `now >= expiresAt` or hold invalid (evaluated lazily on every read/write) |
| PENDING_PAYMENT | PAY | PENDING_PAYMENT | idempotent no-op, only if `acceptedPrice === currentPrice` |
| PENDING_PAYMENT | COMPLETE (charge ok) | COMPLETED | key matches, version current, `acceptedPrice === currentPrice`; sets `orderId` |
| PENDING_PAYMENT | COMPLETE (declined) | FAILED | same guards |
| PENDING_PAYMENT | hold lost | FAILED | evaluated *before* any charge |
| COMPLETED | COMPLETE | COMPLETED | idempotent replay (matching `idempotencyKey`) |

COMPLETED, EXPIRED and FAILED are terminal. Recovery from EXPIRED/FAILED is a new session.

- **Pure core, imperative shell.** `evaluate(session, ctx)` reconciles a session with the world
  (clock, price, hold). `transition(session, event)` applies a fan intent. Both are pure: no I/O,
  no clock reads, no mutation, never touch `version`. `CheckoutService` gathers facts, calls them,
  persists, and runs side effects.
- **Guard order: replays → version check → per-event guards.** A retry carries the version the
  client saw *before* its first attempt succeeded, so checking the version first would turn every
  legitimate retry into a conflict. Replays change nothing, so skipping the version check for them
  can't lose an update.
- **Only COMPLETED is replayed.** FAILED has two causes (declined, or hold lost before any charge),
  so a FAILED replay could report a "replay" of a payment that never happened. A duplicate complete
  on FAILED gets a 409 carrying the FAILED session, and the UI renders recovery from state.
- **Price is locked once payment starts.** `evaluate()` refreshes `currentPrice` only while ACTIVE.
- **`PRICE_CHANGED` is a signal, not a status.** It's orthogonal to the lifecycle (a session can be
  ACTIVE *and* repriced). The view derives it as `currentPrice !== acceptedPrice` (see below).

### Concurrency: optimistic, not locks

Every write is `compareAndSet(id, expectedVersion, next)`, and the store alone bumps `version`
(production: `UPDATE … WHERE id = $1 AND version = $2`). There are no locks held across the slow
payment call and nothing to clean up after a crash. The losing writer gets the fresh session back,
which doubles as the cross-surface UX signal. Node's single thread doesn't make this unnecessary:
every `await` (e.g. on the gateway) is an interleaving point.

## How web and mobile resume the same session

- **The deep link carries only the session id** (`/mobile/checkout/<id>`), never price, version or
  status. A link is a snapshot that may be opened hours later, so the opening surface must resume
  through `GET /checkout/:id`, where the server re-validates expiry, price and hold.
- **Both surfaces server-render from that resume** and keep their own client state: no shared
  memory, only the id. `/demo/[id]` shows them side by side as independent iframes.
- **Re-validate on return.** Each surface re-fetches on `visibilitychange`/`focus`. Concurrent
  triggers share one in-flight request.
- **Render from state.** The screen is `deriveCheckoutView(session, acceptedPrice)`, a pure function
  in `packages/shared` with this precedence:

| # | Condition | Screen |
|---|---|---|
| 1 | COMPLETED | Confirmation + order number ("Already purchased" if this surface's complete was a replay) |
| 2 | FAILED | "We couldn't complete this purchase" + restart |
| 3 | EXPIRED | "Your hold on this seat ended" + restart |
| 4 | ACTIVE or PENDING_PAYMENT with `currentPrice !== acceptedPrice` | **Blocking price banner** |
| 5 | PENDING_PAYMENT | Place order |
| 6 | ACTIVE | Continue to payment + countdown |

  Error codes never drive the screen. A 409 carries the fresh session, and re-deriving shows the
  right view. Codes the view already explains are not shown; anything else is plain language.

## How the hard cases are handled

### Stale inventory
- **One live hold per seat.** A second fan gets `409 SEAT_UNAVAILABLE`. The landing page
  server-renders availability.
- **Hold lifecycle:** `active (until session.expiresAt) → frozen (PENDING_PAYMENT) → sold
  (COMPLETED)`, or `released` (EXPIRED / FAILED / revoked). The hold mirrors the session deadline
  because session expiry is lazy: without that, an abandoned checkout would lock the seat until
  someone happened to re-load it.
- **Lost hold.** ACTIVE → EXPIRED. PENDING_PAYMENT → FAILED **before** the gateway is called.

### Price change
- **`acceptedPrice`** is per-surface client state: the price the fan agreed to *on this surface*. It
  starts at `priceAtStart` (what they committed to when checkout began, not "what this surface last
  showed", which would let mobile display a bumped price with no explanation). Acknowledging sets
  it to the exact price printed on the button pressed.
- **The banner blocks structurally.** It *replaces* the pay button, so there's no control to reach.
  Focus moves to it. It also blocks on decreases (with positive copy).
- **The same rule at two layers.** `pay` and `complete` send `acceptedPrice`; the server rejects a
  mismatch with `PRICE_MISMATCH`. A client bug can't produce a silent charge.
- **Why block, not toast:** consent to the exact amount (live-event ticketing is under all-in
  pricing rules); a toast can be missed while the old CTA is still tappable; the server rejects a
  mismatch anyway, so an upfront gate beats an error after the click.

### Duplicate completion
Two surfaces pressing Place order together both load PENDING_PAYMENT and both pass the pre-charge
dry run. Two independent layers stop two different failures:

| Layer | Stops | How |
|---|---|---|
| `version` compare-and-set | a second **order** | only one `v2 → v3` write can win |
| `idempotencyKey` | a second **charge** | one key per session; the gateway returns the first result (Stripe semantics) |

The losing writer doesn't fail. The service re-loads and re-runs `transition()` with the same event
(same charge result, no new charge). The replay-first guard returns the COMPLETED session, and the
response is **200 `replayed: true`** with the same `orderId`.

Before charging, `complete` dry-runs the transition with a hypothetical success, so a session that is
ACTIVE, expired, stale, at an unaccepted price, or already completed is never charged.

### Expiration
Expiry is evaluated lazily on every read and write, so there's no sweeper to drift. At local zero the
countdown shows "Confirming your hold…" and asks the server, which decides. Recovery is a Server
Action form, so it works before hydration.

## Web performance: SSR first, then hydrate

- **`/checkout/[id]` is a Server Component.** Every request resumes server-side (`cache: 'no-store'`)
  and renders event, seat, price and the starting countdown into the HTML.
- **`EventHeader` ships zero JS.** `CheckoutPanel` is the only client island.
- **Hydration-safe countdown.** The first render uses only props (`expiresAt - serverTime`), so server
  and client produce identical HTML. Ticking starts in `useEffect`, anchored to the **API clock**
  (`serverTime` in every response), so a skewed laptop clock or the dev fast-forward can't lie.
- **Pinned `Intl` formatting** (`en-US`, venue time zone) avoids server/browser mismatches.
- **Buttons render disabled until hydration**, honest about not yet being interactive.

## API

| Route | Purpose |
|---|---|
| `POST /checkout` `{listingId}` | Create session + exclusive hold → 201, or 409 `SEAT_UNAVAILABLE` |
| `GET /checkout/:id?surface=&reason=` | Resume: evaluate + persist; `reason=open` counts as a resume for analytics |
| `POST /checkout/:id/pay` `{expectedVersion, acceptedPrice}` | ACTIVE → PENDING_PAYMENT (freezes the hold) |
| `POST /checkout/:id/complete` `{expectedVersion, idempotencyKey, acceptedPrice}` | Charge → COMPLETED (confirms sale) / FAILED (releases) |
| `GET /listings/:id` | Listing + `available` |
| `POST /events` | Whitelisted client analytics → 204 |

Every response, success or error, carries the current `session` and `serverTime`. Errors: 404 ·
409 `VERSION_CONFLICT` / `PRICE_MISMATCH` / `INVALID_TRANSITION` / `SEAT_UNAVAILABLE` ·
410 `SESSION_EXPIRED` · 422 `IDEMPOTENCY_KEY_MISMATCH` · 503 `BUSY` · 400 invalid body.
Dev-only (not registered in production): `/dev/listings/:id/price`, `/dev/clock/advance`,
`/dev/payments/next-outcome`, `/dev/holds/:holdId/revoke`, `/dev/reset`.

**Side effects** (freeze / confirm / release / analytics) run only after a committed write and are
best-effort: a failure is logged, never turned into a 500 for an operation that succeeded.

**Analytics:** server: `checkout_started`, `status_*`, `price_changed`, `surface_resumed`,
`checkout_replayed`. Client: `price_banner_shown` (once per distinct change, safe under Strict Mode),
`price_banner_acknowledged`.

## Testing

- **State machine:** one test per table row; a **status × event matrix** asserting each cell's
  outcome plus invariants that hold in every cell (input never mutated, the machine never bumps
  `version`, `priceAtStart`/`idempotencyKey` immutable, terminal states never leave); regression
  specs for bugs found in review. 98% branch coverage (only the unreachable `never` fallback is
  uncovered).
- **View derivation:** the precedence table and every price scenario. 100%.
- **Routes + service** via `app.inject()`: duplicate completion under a **forced** worst-case
  interleaving (`BarrierGateway` holds each charge until both requests arrive); a `NaiveGateway`
  test proving the layering (one order, but two charges without key dedupe); seat exclusivity and
  hold lifecycle; resilience; analytics.
- **Browser-verified, not under Jest:** React components (banner blocking, focus, copy).

## Tradeoffs

- **Gateway idempotency over a claim-before-charge state.** A `PROCESSING` status would keep a second
  request from ever reaching the gateway, but needs crash recovery (reconciling a stuck claim). The key
  is the industry-standard tool.
- **Acknowledgment is per-surface and not persisted.** Accepting on web means mobile asks again.
  This errs toward over-asking; a server-side ack would sync it at the cost of a route.
- **No push.** A price change is discovered at the next interaction (refocus, countdown, action),
  never by a silent charge.
- **Abandoned checkouts hold the seat until `expiresAt`.** There's no CANCELLED state.
- **FAILED and EXPIRED don't record why** (declined vs hold lost; timed out vs seat gone), so copy is
  generic.
- **Possession of the session id is enough to act on it**, and the client-sent `idempotencyKey`
  mostly guards against a client mixing up sessions (the server charges with its own copy).
- **`orderId` is the charge id.** Real systems separate orders from payments.
- **Countdown error** ≈ time from API response to hydration (errs generous). The server is the
  authority.

## With more time

- React Testing Library tests for `CheckoutPanel`; a Playwright run of the browser guide.
- `failureReason` / `expiryReason`, for specific copy ("pick another seat" vs "try again").
- Signed, single-use handoff tokens bound to an account (QR / push / universal links).
- Real auth; per-attempt client idempotency keys (`Idempotency-Key` header).
- Postgres with `UPDATE … WHERE version = $n`; an outbox for side effects; gateway reconciliation.
- Server-sent events to surface price changes live; a cancel action that releases the hold.
- `venueTimeZone` on listings; multiple seats; production-build performance numbers (LCP/TTI).

## How this was built

See [AI_USAGE.md](AI_USAGE.md) for who designed and wrote what, and how each step was validated.
