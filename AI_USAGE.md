# AI usage log

Running, honest log of who designed/wrote what, and how AI output was validated.
Updated at every commit.

## Step 1 — State machine, store, stub interfaces

**Designed by me (decisions made after AI laid out alternatives):**
- `PRICE_CHANGED` as a derived signal, not a lifecycle status.
- Price acceptance: `pay` carries `acceptedPrice` (no extra route; `priceAtStart` kept for audit).
- Optimistic concurrency (version CAS) over locking — no locks held across payment calls;
  the 409 conflict payload *is* the cross-surface UX.
- No expiry during PENDING_PAYMENT (hold frozen while money moves).
- FAILED is terminal; recovery = new session.
- Duplicate completion returns 200 `replayed: true`, not 409.

**Scaffolded by AI (reviewed by me):**
- npm workspaces, TS config, Jest/ts-jest setup (TypeScript pinned to 5.9: npm pulled TS 7, which ts-jest 29 cannot run).
- Shared types, `InMemorySessionStore` (clone-in/clone-out, store-owned version bump),
  `InventoryService` / `PaymentGateway` / `AnalyticsSink` / `Clock` interfaces + stubs.
- Store unit tests; state-machine test todos mirroring the transition table.
- AI review edits to my first-draft types: removed `now` from events (single time source),
  dropped `EVALUATE_EXPIRY` event in favor of a separate `evaluate()`, string errors →
  `TransitionErrorCode` union, `compareAndSet` returns the stored session instead of boolean.

**Written by me:** `evaluate()` and `transition()` in `apps/api/src/domain/checkout-machine.ts`.
- `evaluate()`: lazy expiry; invalid hold (seat sold elsewhere) → EXPIRED; price refreshed only while ACTIVE.
- `transition()`: replay checks → version check → per-event guards.

**AI review of my first draft found (I fixed all of these):**
- Compile error: treated `chargeOutcome` as an object.
- **Guard-ordering bug:** version check ran first, so every legitimate replay (retried PAY,
  second surface completing) got `VERSION_CONFLICT` — replays carry a stale version by
  construction. Moved replay checks ahead of the version check.
- Re-PAY must still verify `acceptedPrice === currentPrice`, or a stale tab could proceed to
  charge a price it never displayed.
- PAY on COMPLETED/FAILED returned `SESSION_EXPIRED`; now `INVALID_TRANSITION`.
- Added a `never` exhaustiveness check on the event union.

**Validation:**
- AI wrote 4 regression tests encoding the review findings *before* my fix; they failed against
  the first draft and pass against the revision. 5 store tests pass. `tsc --noEmit` clean.
- Full transition-table coverage is deferred to step 8 (left as `it.todo`).

## Step 2 — API routes

**Scaffolded by AI (reviewed by me):**
- `CheckoutService` (functional-core / imperative-shell around my machine): `load()` evaluates +
  persists on every read; `apply()` runs transition + CAS; side effects only after a successful write.
- Dry-run-before-charge in `complete` (pure transition with hypothetical success gates the gateway call).
- Fastify app with JSON-schema validation, error → HTTP mapping, dev-only demo routes, `OffsetClock`.
- Route smoke tests via `app.inject()`; `scripts/demo-api.sh` curl walkthrough.
- Tooling fix: Jest runs with `--experimental-vm-modules` because Fastify's `inject()` pulls in
  ESM-only `cookie@2`.

**Observed while validating:** sequential double-complete already replays correctly because of
the replay-first guard order in my `transition()`. What remains for step 7 is the *concurrent*
race (both requests past the dry run before either writes), replay signaling, and tests.

**Validation:** 15 tests pass (store, machine regressions, 6 route tests), `tsc` clean; ran the
server and walked all three scenarios with `scripts/demo-api.sh` — output matched the
transition table by hand.

## Step 3 — Web checkout screen (SSR + countdown)

**Scaffolded by AI (reviewed by me):** Next 16 App Router app (manual setup, `/api` rewrite proxy,
`transpilePackages`), landing page with a Server Action, SSR checkout page, `EventHeader` (server)
vs `CheckoutPanel` (client island) split, hydration-safe `Countdown`, `useHydrated` badge, CSS.
API change: every response now carries `serverTime`; added read-only `GET /listings/:id`.

**Bugs found while validating in the browser (fixed):**
- API bound to port 3000: the preview launcher sets `PORT` for the whole process tree and the API
  read `PORT`. Switched to a dedicated `API_PORT`.
- Hydration badge showed a misleading 4.8s: `performance.now()` counts from the *document* load,
  and the Server Action redirect is a client-side navigation. Now reports timing only on a real
  document load.

**Validation:** typecheck clean, 16 API tests pass. In the browser: landing → start → checkout
renders; `curl` of the page shows event/seat/price/countdown in raw HTML with the badge in its
pre-hydration state; no hydration warnings in the console; pay → place order → confirmed;
fast-forwarded the API clock 4:50, loaded the page → countdown showed 0:07 (API-anchored, not
browser clock) → at zero it re-fetched and rendered EXPIRED.

**Known gap (deliberate):** a changed price currently just renders the new `currentPrice`. The
blocking price banner is step 5, which I'm designing.

## Step 4 — Simulated mobile resume

**Scaffolded by AI (reviewed by me):** `HandoffLink` (plain `<a>` carrying only the id),
`/m/checkout/[id]` phone-frame route, `/demo/[id]` side-by-side iframes, re-validate on
`visibilitychange`/`focus` in `CheckoutPanel`. Demo listing switched to a Miami Heat game at my request.

**Design boundary:** the re-fetch *trigger* is plumbing (it only calls GET). How a changed session
is *presented* (price banner, expiry recovery) is step 5, which I'm designing.

**Found while validating (fixed):**
- The browser pane fires focus/visibility events into every frame, so my first cross-surface test
  couldn't attribute updates to the trigger. Measured instead: 0 requests while idle (no loop),
  exactly 1 per focus event.
- A real tab switch fires both `visibilitychange` and `focus` → duplicate GETs. Added an in-flight
  guard; verified focus+visibility together = 1 request.
- Mobile iframe at 440px tripped the page's own ≤480px breakpoint and lost its bezel; made the
  iframe itself the phone frame.

**Validation:** typecheck clean, 16 API tests pass. In the browser: web page → side-by-side demo;
both surfaces SSR the same session with matching API-anchored countdowns; paying on mobile and
completing out-of-band via curl were both reflected on web after re-validation.

## Step 5: Price-change + expiration UX ("core two state changes" milestone)

**Designed by me (after AI laid out alternatives):** view logic as a pure shared
`deriveCheckoutView`; client-local `acceptedPrice` starting at `priceAtStart`; block on price
decreases too; inline banner replacing the pay button; one-tap recovery on the same surface.
Closed the PENDING_PAYMENT gap the AI raised: the banner rule applies to PENDING_PAYMENT too
(option a), with a server-side `acceptedPrice` guard on `complete` planned for step 7 (option b).

**Written by me:** `deriveCheckoutView()` (packages/shared/src/view-derived.ts) and
`useAcceptedPrice()` (apps/web/lib/useAcceptedPrice.ts).

**Scaffolded by AI (I drafted a first version; AI review changed it):** view types,
`PriceChangeBanner`, `RestartCheckout`, `CheckoutPanel` wiring, shared Jest setup. Review changes:
- My restart action always redirected to the web route; folded into `startCheckout` with a
  surface → path whitelist (also avoids an open redirect).
- Banner now passes the *printed* price to `acknowledge` (a re-fetch between render and tap would
  otherwise accept a price the fan never saw).
- Focus moves to the banner (labelled region) instead of `role="alert"` + unused `tabIndex`.
- Test file imported a factory from `apps/api`; shared must not depend on apps.

**AI review of my code:**
- Countdown was shown for any PRICE_CHANGED view; with my PENDING_PAYMENT rule that would show a
  ticking timer on a frozen hold. Wiring now gates the countdown on `status === 'ACTIVE'`.
- `key={session.id}` added on `CheckoutPanel` so a restart (new id) remounts with fresh state.
- Open note on my hook: its `useEffect` that re-syncs `acceptedPrice` from props is redundant
  given the key, and is a footgun (a caller passing `currentPrice` would silently auto-accept
  every change). Kept as written for now; candidate to remove.

**Validation:** 12 new view tests (precedence, PENDING gap, drop, double bump, bounce-back,
fresh-mobile, purity) all pass; API suite still green; typecheck clean. In the browser:
(1) price bump on resume → banner, no pay button, focus on banner, countdown ticking → accept →
pay at $210 accepted by server; (2) same PENDING session opened on mobile → banner, no Place order,
no countdown → accept → Place order $210; (3) expired session on mobile → restart → new session id,
stayed on `/m/`, fresh $210 hold, no banner.

## Cleanup after milestone

- **My call:** renamed the mobile route `/m/checkout/[id]` → `/mobile/checkout/[id]` for clarity.
  Earlier log entries mention `/m/` because that was the route at the time.
- **My refactor:** removed the `useEffect` from `useAcceptedPrice`. `key={session.id}` already
  remounts the panel for a new session, so the sync effect only added an extra render and a
  footgun (a caller passing `currentPrice` would silently auto-accept every change).
- **Validation:** typecheck clean, all tests pass; `/mobile/checkout/<id>` → 200 and old `/m/` → 404;
  handoff link and demo iframe point at `/mobile`; restart from an expired mobile session landed on
  `/mobile/checkout/<new id>`.

## Step 7: Duplicate completion (idempotency + version)

**Decided by me:** rely on gateway idempotency rather than a claim-before-charge `PROCESSING`
state (avoids crash-recovery complexity); `acceptedPrice` guard on COMPLETE placed *after* the
replay check (a replay changes nothing and charges nothing, so COMPLETED is the truth); add
`orderId` so "one order" is visible in the UI, not only in tests.

**Written by me:** `transition()` changes: COMPLETE price guard and `orderId` from `chargeId`
(null on decline, unchanged on replay). Removed the unused `sessionId` param from `useAcceptedPrice`.

**Scaffolded by AI (reviewed by me):** contract additions (`orderId`, COMPLETE `acceptedPrice` +
`chargeId`, `replayed`); service re-runs the machine on CAS loss (turns the loser into a replay
without re-charging); `replayed` flag in responses; complete schema; "Already purchased" + order
number UI; `BarrierGateway` (forces worst-case interleaving) and `NaiveGateway` (shows layering)
race tests; specs for my machine changes written red-first; demo script fires parallel completes.

**Validation:** specs were red before my change (4 failing, each needing my code; the concurrent
test failed only at the `orderId` assertion), and green after: 42 API + 12 shared tests pass,
typecheck clean. `scripts/demo-api.sh`: parallel completes → both 200, same order id, one
`[replayed]`. Browser side-by-side: both "Place order" buttons clicked in the same tick → web
"Order confirmed", mobile "Already purchased… charged once", identical order id.

## Pre-step-8 code review

**AI reviewed the whole codebase at my request** and verified two must-fix bugs against the running
server: two fans could hold (and buy) the same seat, and a fan was charged after their hold was
revoked mid-payment. 15 items total; I assigned ownership for each.

**Decided by me:** accept abandoned holds as a tradeoff (released at expiry, no CANCELLED state);
locked the analytics event list (`surface_resumed`, `price_banner_shown`,
`price_banner_acknowledged`, `checkout_replayed`). My items, still to do: `!holdValid` in
PENDING_PAYMENT → FAILED before charging; suppress/map raw error codes in `CheckoutPanel`;
symmetric FAILED replay.

**Fixed by AI (reviewed by me):**
- Exclusive holds + `SEAT_UNAVAILABLE` (409); landing page server-renders availability; restart
  into an unavailable seat bounces to the listing with an explanation.
- Hold lifecycle `active → frozen → sold | released` with `freeze`/`confirm`. This revises the
  earlier "holds have no TTL" call: with exclusivity plus lazy session expiry, an abandoned hold
  would otherwise lock the seat indefinitely.
- Best-effort side effects with logging; `load()` returns 503 `BUSY` with the last stored session
  instead of throwing.
- Analytics plumbing: `surface_resumed` (GET `?surface=`), `checkout_replayed`, whitelisted
  `POST /events`, banner events wired with a Strict-Mode-safe once-per-change guard.
- `app/error.tsx` boundary; pending copy on pay/place-order buttons; `/dev/reset` + demo-page
  reset link; demo script resets between scenarios and adds "two fans, one seat".

**Validation:** 15 new API tests (exclusivity, abandoned-hold release, freeze survives expiry,
confirm is permanent, FAILED releases, availability, side-effect failure → still 200, analytics,
events whitelist) + 5 inventory stub tests. All 41 API + 12 shared tests pass; typecheck clean.
Demo script: all 4 scenarios correct. Browser: landing shows "Seat unavailable" while held; banner
fired `price_banner_shown` exactly once and `price_banner_acknowledged` on accept; with the API
stopped, the checkout page rendered the error boundary.
