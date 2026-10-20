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
