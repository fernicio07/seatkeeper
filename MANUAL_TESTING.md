# Manual test script

A step-by-step, end-to-end walkthrough of every scenario in the brief
("02 — Checkout Continuity"). Each test lists **what the brief asks**, the **steps**, and the
**expected result**. Allow about 25 minutes for the full pass. Tests are independent: **reset
between tests** unless a test says otherwise.

## 0. Setup

```bash
npm install
npm run dev        # API → http://localhost:4000 · web → http://localhost:3000
```

Keep three things open:

| | Where | Used for |
|---|---|---|
| **Browser** | http://localhost:3000 | The fan's surfaces (use a second tab or window as the "other device") |
| **Terminal** | any shell | Dev levers (below) |
| **Analytics** | http://localhost:4000/dev/analytics | The event log + conversion funnel, live (refresh to update) |

**Dev levers** (only registered in dev):

```bash
# Reset: seat back on sale, prices restored, next charge succeeds. Also: "Reset demo" link on the landing page.
curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'

# Change the price (cents)
curl -s -X POST localhost:4000/dev/listings/lst_heat_1/price -H 'content-type: application/json' -d '{"price":21000}'

# Skip time on the API clock (5 minutes = the full hold)
curl -s -X POST localhost:4000/dev/clock/advance -H 'content-type: application/json' -d '{"ms":300000}'

# Make the next charge decline
curl -s -X POST localhost:4000/dev/payments/next-outcome -H 'content-type: application/json' -d '{"outcome":"declined"}'

# Revoke a hold (simulates the seat being pulled by the inventory system)
curl -s -X POST localhost:4000/dev/holds/<holdId>/revoke
# find a session's holdId:
curl -s localhost:4000/checkout/<sessionId> | grep -o 'hold_[a-z0-9-]*'
```

The **session id** is the last part of the checkout URL (`/checkout/cs_…`).

> **"Return to the tab"** below means: click back into the browser window or tab. Each surface
> re-validates with the server when it regains focus. That's the resume mechanism under test.

---

## 1. Automated checks (2 min)

```bash
npm test                  # expect: 80 API + 12 shared tests pass
npm run typecheck         # expect: no errors
./scripts/demo-api.sh     # expect: four scenarios; ✗ only where the label says it should fail
```

**Expected from the script:** stale pay → `VERSION_CONFLICT`; wrong price → `PRICE_MISMATCH`;
pay after expiry → `SESSION_EXPIRED`; parallel completes → both `COMPLETED`, **same `order=`**,
exactly one `[replayed]`; second fan → `SEAT_UNAVAILABLE`.

---

## 2. Creating a session — *brief: "Creating a checkout session for a selected listing"*

### T1 · Start checkout
1. Open http://localhost:3000.
2. Press **Start checkout**.

**Expected**
- [ ] URL becomes `/checkout/cs_…`.
- [ ] Event, venue, date (Fri, Nov 13, 7:30 PM EST), Section 112 · Row F · Seat 7, **$185.00**.
- [ ] "Seat held for 4:59" counting down; **Continue to payment** enabled.
- [ ] Analytics: `checkout_started` with `surface: "web"`, then `surface_resumed`.

---

## 3. Fast web surface — *brief: "render enough context before JavaScript finishes"*

### T2 · Server-rendered before hydration
1. With a checkout open (T1), copy its id and run:
   ```bash
   curl -s localhost:3000/checkout/<sessionId> | grep -o 'Miami Heat[^<]*\|\$185.00\|Seat held for\|Server-rendered · hydrating…'
   ```
2. In the browser, look at the small badge under the panel.
3. *(Optional)* DevTools → disable JavaScript → reload.

**Expected**
- [ ] The raw HTML (no JS executed) already contains event, price, countdown, and the badge text
      "Server-rendered · hydrating…".
- [ ] In the browser the badge reads **"Interactive · hydrated Nms after navigation"**.
- [ ] With JS disabled: the full screen still renders, the countdown is frozen, buttons are disabled.
- [ ] No hydration warnings in the browser console.

---

## 4. Resuming on a second surface — *brief: "Resuming that session from a second surface… deep-link route"*

### T3 · Web → mobile
1. On the web checkout, press **📱 Continue on your phone**.

**Expected**
- [ ] A new tab opens `/mobile/checkout/<same id>` in a phone frame: "Resumed from a link · session …".
- [ ] Same seat and price; the countdown matches web to within a second (both use the API clock).
- [ ] Analytics: `surface_resumed` with `surface: "mobile"`.

### T4 · Mobile → desktop (the brief's "discover on mobile, complete on desktop")
1. On the mobile surface, press **💻 Continue on desktop**.

**Expected**
- [ ] `/checkout/<same id>` opens with the same state.
- [ ] Analytics: `surface_resumed` with `surface: "web"`.

### T5 · Each surface re-validates on return
1. Keep web and mobile tabs open on the same session.
2. On **mobile**, press **Continue to payment** → it shows *Paying with Visa •••• 4242 · Place order*.
3. **Return to the web tab** (don't reload).

**Expected**
- [ ] Web updates by itself to **Place order · $185.00** (PENDING_PAYMENT), with no reload.
- [ ] The countdown disappears on both (the hold is frozen while paying).

---

## 5. Price changed while away — *brief: "What should the fan see if the price changed while they were away?"*

### T6 · Price increase blocks continuation
1. Reset → Start checkout on web.
2. Bump the price to 21000.
3. Return to the tab.

**Expected**
- [ ] The **Continue to payment** button is gone, replaced by a banner: "The price of this seat changed
      · ~~$185.00~~ → **$210.00** (+$25.00)".
- [ ] Keyboard focus is on the banner. The countdown keeps running.
- [ ] Analytics: `price_changed` 18500→21000, then `price_banner_shown` (**once**, even after refocusing).
4. Press **Continue at $210.00** → **Continue to payment**.
- [ ] Moves to *Place order · $210.00*. Analytics: `price_banner_acknowledged`.

### T7 · Stale tab that never saw the price
1. Reset → Start checkout on web (keep this tab, don't touch it).
2. Press **📱 Continue on your phone**.
3. Bump the price to 21000.
4. On **mobile**: return to the tab → banner → **Continue at $210.00** → **Continue to payment**.
5. **Return to the web tab.**

**Expected**
- [ ] Web shows the banner ~~$185.00~~ → **$210.00**. **No Place order button and no countdown.** This
      surface never agreed to $210, even though the other device did.
- [ ] After **Continue at $210.00**, web shows *Place order · $210.00*.

### T8 · Price drop still needs consent
1. Reset → Start checkout → set price to 16000 → return to the tab.

**Expected**
- [ ] Banner: "Good news: the price dropped · ~~$185.00~~ → **$160.00** (−$25.00)". Pay still blocked
      until **Continue at $160.00**.

---

## 6. Inventory expiration — *brief: "inventory expiration… holding stale inventory forever"*

### T9 · Expiry and recovery on web
1. Reset → Start checkout.
2. Skip 5 minutes.
3. Return to the tab.

**Expected**
- [ ] "Your hold on this seat ended" + **Check availability again**. No pay button.
- [ ] Analytics: `status_expired`.
4. Press **Check availability again**.
- [ ] Lands on a **new** `/checkout/cs_…` id with a fresh 5:00 hold.

### T10 · Recovery stays on the same surface (mobile)
1. Reset → Start checkout → **📱 Continue on your phone** → skip 5 minutes → return to the mobile tab.
2. Press **Check availability again**.

**Expected**
- [ ] The new session opens at `/mobile/checkout/cs_…` (still mobile, not bounced to web).

### T11 · Abandoned checkout frees the seat by itself
1. Reset → Start checkout, then **close that tab** (abandon it).
2. Open http://localhost:3000. **Expected:** "Seat unavailable" (the hold is live).
3. Skip 5 minutes and reload the landing page **without** reopening the old checkout.

**Expected**
- [ ] **Start checkout** is enabled again. The hold expired on its own, with no one re-loading
      the abandoned session.

---

## 7. Stale inventory between fans — *brief: "Inventory can disappear"*

### T12 · Two fans, one seat
1. Reset → Start checkout (fan A).
2. In another tab, open http://localhost:3000 (fan B).

**Expected**
- [ ] Fan B sees "This seat is held or sold…" and a disabled **Seat unavailable** button.
3. *(Race variant)* Open the landing page in tab B **before** A starts, then start in A, then press
   Start checkout in B.
- [ ] B is bounced back to the listing: "Someone else is checking out this seat right now…".

### T13 · Seat pulled while paying (hold lost mid-payment)
1. Reset → Start checkout → **Continue to payment** (now *Place order*).
2. Find the hold id and revoke it (see levers).
3. Press **Place order**.

**Expected**
- [ ] "We couldn't complete this purchase · You weren't charged…" + **Check availability again**.
- [ ] Analytics: `status_failed` and **no** `status_completed` (nothing was charged).

---

## 8. Payment failure — *brief: "payment authorization can fail… completion failure"*

### T14 · Card declined
1. Reset → set the next charge to decline → Start checkout → **Continue to payment** → **Place order**.

**Expected**
- [ ] "We couldn't complete this purchase · You weren't charged…" + **Check availability again**.
- [ ] Open the landing page: the seat is **available** again (a failed checkout releases its hold).
- [ ] Analytics: `status_failed`.

---

## 9. Duplicate orders — *brief: "How do you prevent duplicate orders when two devices resume the same session?"*

### T15 · Two devices, by hand: convergence
1. Reset → Start checkout on web → **📱 Continue on your phone**.
2. On web: **Continue to payment**. Return to the mobile tab: it shows *Place order*.
3. On **mobile**: **Place order** → "You're going! Order confirmed · Order ch_…". Note the order id.
4. Return to the web tab.

**Expected**
- [ ] Web shows "Order confirmed" with the **same order id**. There's no second *Place order* to press.
- [ ] Open the landing page: **Seat unavailable** (sold).

### T16 · Two devices pressing at the same moment: idempotent replay
1. Reset → Start checkout → open **Side-by-side demo** (link under the checkout card).
2. In the web frame press **Continue to payment**, then click once inside the mobile frame. Both
   now show *Place order*.
3. Press **⚡ Race both surfaces** (toolbar at the top).

**Expected**
- [ ] One frame: "You're going! Order confirmed". The other: **"Already purchased · This order was
      already placed from another device. You were charged once."**
- [ ] **Identical order id** in both frames.
- [ ] Analytics: one `status_completed`, one `checkout_replayed`.

---

## 10. Instrumentation — *brief: "How would you instrument this flow to know whether continuity improves checkout conversion?"*

### T17 · Read the funnel
Run T3 → T15 (a cross-surface purchase) and T9 (a single-surface expiry) without resetting the
API process, then open http://localhost:4000/dev/analytics.

**Expected `funnel`**
- [ ] `sessions` and `completed` counts reflect what you did.
- [ ] `crossSurface` (sessions resumed on a surface other than where they started) vs `singleSurface`,
      each with its own `conversion`. This comparison answers the brief's question.
- [ ] `priceBanner.shown` / `acknowledged` / `ackRate`, plus `expired`, `failed`, `replayedRequests`.

---

## 11. Resilience (optional)

### T18 · API down → friendly error, not a stack trace
1. Stop **only** the API: `lsof -ti tcp:4000 -sTCP:LISTEN | xargs kill`
   (plain `lsof -ti tcp:4000` also matches the Next server, which holds connections to the API).
2. Load any `/checkout/cs_…` page.

**Expected**
- [ ] "We couldn't load your checkout · Loading a page never charges you…" + **Try again**.
      (In dev, Next's error overlay may also appear on top.)
3. Restart with `npm run dev`.

---

## Coverage: brief → tests

| Brief says | Manual | Automated |
|---|---|---|
| Create a checkout session for a selected listing | T1 | `app.test.ts` happy path |
| Resume from a second surface / deep-link route | T3, T4 | route tests; `surface_resumed` tests |
| ≥2 fan-facing state changes | T6–T8 price, T9–T11 expiry, T13–T14 failure, T5 payment pending | machine matrix, view tests, route tests |
| Source of truth for session + expiration (backend) | T5, T9 | `evaluate` tests, transition matrix |
| Fast, stable web before JS | T2 | — (browser-verified) |
| Mobile opens same session via deep link, platform recovery states | T3, T10 | — (browser-verified) |
| Stale inventory never held forever | T11, T12, T13 | inventory exclusivity + lifecycle tests |
| Price change never hidden | T6, T7, T8 | view derivation tests; `PRICE_MISMATCH` route tests |
| No duplicate orders across devices | T15, T16 | `BarrierGateway` / `NaiveGateway` race tests |
| Instrumentation for conversion | T17 | `funnel.test.ts`; analytics route tests |
| Small API: create, resume, complete | T1, script | `app.test.ts` |
| Cross-surface transitions visible in UI | T5, T7, T15, T16 | — |
| Tests or scripted scenarios | §1 | `npm test`, `scripts/demo-api.sh` |
