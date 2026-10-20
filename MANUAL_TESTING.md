# Manual test script

A step-by-step, end-to-end walkthrough of every scenario in the brief ("02 — Checkout
Continuity"). Every step is marked:

- **🖱 Browser**: something you click or look at.
- **⌨️ Terminal**: a command to paste into the **command tab** (see Setup). Each command shows
  what it should print.

Allow about 25 minutes. Tests are independent: each one starts with its own reset.

---

## 0. Setup (once)

Open **two terminal tabs** in the repo folder.

**⌨️ Tab 1: the servers.** Leave this running for the whole session:

```bash
nvm use && npm install && npm run dev
```

Wait for `✓ Ready` and no `EADDRINUSE` error. API: http://localhost:4000 · web: http://localhost:3000.

**⌨️ Tab 2: the command tab.** All other ⌨️ commands go here. Run `nvm use` once in this tab too:

```bash
nvm use
```

**🖱 Browser:** open http://localhost:3000. Keep http://localhost:4000/dev/analytics in a second
tab: it's the live event log (refresh it to update).

### Two things you'll do often

**Reset the demo.** Puts the seat back on sale, restores the price, makes the next charge succeed.
Either click **Reset demo (dev)** at the bottom of the landing page, or:

```bash
curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
```

Prints `{"reset":true}`.

**Capture the session id.** Some steps need the current session's id. It's the last part of the
checkout URL, starting with `cs_` (for example `/checkout/cs_1a2b…`). Copy it from the address bar,
then in Tab 2:

```bash
ID=cs_PASTE_YOUR_ID_HERE
```

> **"Return to the tab"** means: click anywhere inside the browser page. A surface re-validates with
> the server when it regains focus, and that's the behavior under test. Running a command in the
> terminal takes focus away from the browser, so clicking back in triggers it.

---

## 1. Automated checks (2 min)

**⌨️** Run each, in Tab 2:

```bash
npm test
```

Expect `Tests: 12 passed` (shared) and `Tests: 80 passed` (API). If `app.test.ts` fails with
`diagnostics.tracingChannel is not a function`, this tab isn't on Node 24: run `nvm use`.

```bash
npm run typecheck
```

Expect no output besides the three `tsc` lines.

```bash
./scripts/demo-api.sh
```

Expect four scenarios. `✗` appears only on rows meant to fail: stale pay → `VERSION_CONFLICT`,
wrong price → `PRICE_MISMATCH`, pay after expiry → `SESSION_EXPIRED`, fan B → `SEAT_UNAVAILABLE`.
In scenario 3, both rows show the **same `order=`** and exactly one says `[replayed]`.

---

## 2. Creating a session · *brief: "Creating a checkout session for a selected listing"*

### T1 · Start checkout

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** Open http://localhost:3000 and press **Start checkout**.

**Expected**
- [ ] URL becomes `/checkout/cs_…`.
- [ ] Miami Heat vs. Boston Celtics · Kaseya Center · Fri, Nov 13, 7:30 PM EST · Section 112, Row F,
      Seat 7 · **$185.00**.
- [ ] "Seat held for 4:59", counting down. **Continue to payment** is enabled.
- [ ] **🖱** Refresh the analytics tab: `checkout_started` with `"surface":"web"`, then `surface_resumed`.

---

## 3. Fast web surface · *brief: "render enough context before JavaScript finishes"*

### T2 · Server-rendered before hydration

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout**. Copy the session id from the URL.
3. **⌨️** Save it, then fetch the raw HTML (no JavaScript runs in `curl`):
   ```bash
   ID=cs_PASTE_YOUR_ID_HERE
   ```
   ```bash
   curl -s localhost:3000/checkout/$ID | grep -oE 'Miami Heat vs\. Boston Celtics|\$185\.00|Seat held for|Server-rendered · hydrating…' | sort -u
   ```
4. **🖱** Look at the small badge under the panel.
5. **🖱** *(Optional)* DevTools → Settings → Disable JavaScript → reload. Re-enable afterwards.

**Expected**
- [ ] Step 3 prints exactly four lines: `$185.00`, `Miami Heat vs. Boston Celtics`, `Seat held for`,
      and `Server-rendered · hydrating…`. The page is complete before any JavaScript.
- [ ] The badge in the browser reads **"Interactive · hydrated Nms after navigation"**.
- [ ] With JS disabled: the full screen renders, the countdown is frozen, buttons are disabled.
- [ ] Browser console: no hydration warnings.

---

## 4. Resuming on a second surface · *brief: "Resuming that session from a second surface… deep-link route"*

### T3 · Web → mobile

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout**.
3. **🖱** Press **📱 Continue on your phone**. A new tab opens.

**Expected**
- [ ] The new tab is `/mobile/checkout/<same id>` in a phone frame: "Resumed from a link · session …".
- [ ] Same seat and price. The countdown matches the web tab within a second.
- [ ] Analytics: `surface_resumed` with `"surface":"mobile"`.

### T4 · Mobile → desktop (the brief's "discover on mobile, complete on desktop")

1. **🖱** Continue from T3. On the mobile tab, press **💻 Continue on desktop**.

**Expected**
- [ ] `/checkout/<same id>` opens with the same state.
- [ ] Analytics: another `surface_resumed`, with `"surface":"web"`.

### T5 · Each surface re-validates on return

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout** → **📱 Continue on your phone**. You now have a
   web tab and a mobile tab on the same session.
3. **🖱** On the **mobile** tab: press **Continue to payment**. It shows *Paying with Visa •••• 4242*
   and **Place order · $185.00**.
4. **🖱** Switch to the **web** tab. Don't reload.

**Expected**
- [ ] Web updates on its own to **Place order · $185.00**.
- [ ] No countdown on either tab (the hold is frozen while paying).

---

## 5. Price changed while away · *brief: "What should the fan see if the price changed while they were away?"*

### T6 · A price increase blocks continuation

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout**. You see **$185.00** and **Continue to payment**.
3. **⌨️** Raise the price to $210.00. The amount is in cents:
   ```bash
   curl -s -X POST localhost:4000/dev/listings/lst_heat_1/price -H 'content-type: application/json' -d '{"price":21000}'
   ```
   Prints `{"listingId":"lst_heat_1","price":21000}`.
4. **🖱** Return to the checkout tab (click inside the page).

**Expected**
- [ ] **Continue to payment** is gone, replaced by a banner: "The price of this seat changed",
      ~~$185.00~~ → **$210.00** (+$25.00).
- [ ] Keyboard focus is on the banner. The countdown keeps running.
- [ ] Analytics: `price_changed` (18500 → 21000), then `price_banner_shown` **once**. Click out
      and back in: it still appears only once.
5. **🖱** Press **Continue at $210.00**, then **Continue to payment**.
- [ ] The tab shows **Place order · $210.00**. Analytics: `price_banner_acknowledged`.

### T7 · A stale tab that never saw the new price

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout** (the **web** tab). Then **📱 Continue on your
   phone** (the **mobile** tab).
3. **⌨️** Raise the price:
   ```bash
   curl -s -X POST localhost:4000/dev/listings/lst_heat_1/price -H 'content-type: application/json' -d '{"price":21000}'
   ```
4. **🖱** **Mobile** tab: click inside it. The banner appears. Press **Continue at $210.00**, then
   **Continue to payment**. It shows **Place order · $210.00**.
5. **🖱** Switch to the **web** tab and click inside it.

**Expected**
- [ ] Web shows the banner ~~$185.00~~ → **$210.00**, with **no Place order button and no
      countdown**. This surface never agreed to $210, even though the other device did.
- [ ] After **Continue at $210.00**, web shows **Place order · $210.00**.

### T8 · A price drop still needs consent

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout**.
3. **⌨️** Lower the price to $160.00:
   ```bash
   curl -s -X POST localhost:4000/dev/listings/lst_heat_1/price -H 'content-type: application/json' -d '{"price":16000}'
   ```
4. **🖱** Return to the checkout tab.

**Expected**
- [ ] Banner: "Good news: the price dropped", ~~$185.00~~ → **$160.00** (−$25.00).
- [ ] No pay button until **Continue at $160.00** is pressed.

---

## 6. Inventory expiration · *brief: "inventory expiration… holding stale inventory forever"*

### T9 · Expiry and recovery on web

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout**.
3. **⌨️** Skip 5 minutes on the API clock (the full hold):
   ```bash
   curl -s -X POST localhost:4000/dev/clock/advance -H 'content-type: application/json' -d '{"ms":300000}'
   ```
   Prints `{"now":…}`.
4. **🖱** Return to the checkout tab.

**Expected**
- [ ] "Your hold on this seat ended" and **Check availability again**. No pay button.
- [ ] Analytics: `status_expired`.
5. **🖱** Press **Check availability again**.
- [ ] You land on a **new** `/checkout/cs_…` id with a fresh **Seat held for 4:59**.

### T10 · Recovery stays on the same surface (mobile)

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout** → **📱 Continue on your phone**.
3. **⌨️** Skip 5 minutes:
   ```bash
   curl -s -X POST localhost:4000/dev/clock/advance -H 'content-type: application/json' -d '{"ms":300000}'
   ```
4. **🖱** Click inside the **mobile** tab → "Your hold on this seat ended" → **Check availability again**.

**Expected**
- [ ] The new session opens at `/mobile/checkout/cs_…` (still mobile, not bounced to web).

### T11 · An abandoned checkout frees the seat by itself

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout**, then **close that tab** (abandon it).
3. **🖱** Open http://localhost:3000 in a new tab.
   - [ ] It says "This seat is held or sold…" and the button is **Seat unavailable** (the hold is live).
4. **⌨️** Skip 5 minutes. Don't reopen the old checkout:
   ```bash
   curl -s -X POST localhost:4000/dev/clock/advance -H 'content-type: application/json' -d '{"ms":300000}'
   ```
5. **🖱** Reload the landing page.

**Expected**
- [ ] **Start checkout** is enabled again. The hold expired on its own, without anyone re-opening the
      abandoned session.

---

## 7. Stale inventory between fans · *brief: "Inventory can disappear"*

### T12 · Two fans, one seat

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** Tab A: http://localhost:3000 → **Start checkout** (fan A holds the seat).
3. **🖱** Tab B: open http://localhost:3000 (fan B).

**Expected**
- [ ] Fan B sees "This seat is held or sold…" and a disabled **Seat unavailable** button.

**Race variant** (fan B's page was loaded *before* fan A took the seat):

4. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
5. **🖱** Tab B: reload http://localhost:3000. **Start checkout** is enabled. Don't press it yet.
6. **🖱** Tab A: http://localhost:3000 → **Start checkout**.
7. **🖱** Tab B: now press **Start checkout** on the stale page.
- [ ] Fan B is bounced back to the listing: "Someone else is checking out this seat right now…".

### T13 · The seat is pulled while paying (hold lost mid-payment)

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout** → **Continue to payment**. You see **Place order**.
   Copy the session id from the URL.
3. **⌨️** Save the id, then revoke this session's inventory hold (as if inventory pulled the seat):
   ```bash
   ID=cs_PASTE_YOUR_ID_HERE
   ```
   ```bash
   HOLD=$(curl -s localhost:4000/checkout/$ID | grep -o 'hold_[a-z0-9-]*' | head -1) && curl -s -X POST localhost:4000/dev/holds/$HOLD/revoke
   ```
   Prints `{"revoked":"hold_…"}`.
4. **🖱** Return to the checkout tab (click inside the page). Returning re-validates, so the server
   notices the lost hold right away.

**Expected**
- [ ] "We couldn't complete this purchase · You weren't charged…" and **Check availability again**.
- [ ] Analytics: `status_failed` and **no** `status_completed`. Nothing was charged.

---

## 8. Payment failure · *brief: "payment authorization can fail… completion failure"*

### T14 · Card declined

1. **⌨️** Reset, then make the next charge decline:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
   ```bash
   curl -s -X POST localhost:4000/dev/payments/next-outcome -H 'content-type: application/json' -d '{"outcome":"declined"}'
   ```
   Prints `{"nextOutcome":"declined"}`.
2. **🖱** http://localhost:3000 → **Start checkout** → **Continue to payment** → **Place order**.

**Expected**
- [ ] "We couldn't complete this purchase · You weren't charged…" and **Check availability again**.
- [ ] **🖱** Open http://localhost:3000: the seat is **available** again (a failed checkout releases
      its hold).
- [ ] Analytics: `status_failed`.

---

## 9. Duplicate orders · *brief: "How do you prevent duplicate orders when two devices resume the same session?"*

### T15 · Two devices, by hand: convergence

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout** (web tab) → **📱 Continue on your phone** (mobile tab).
3. **🖱** Web tab: **Continue to payment**.
4. **🖱** Mobile tab: click inside it. It shows **Place order**. Press it. You see "You're going!
   Order confirmed · Order ch_…". Note the order id.
5. **🖱** Switch to the web tab and click inside it.

**Expected**
- [ ] Web shows "Order confirmed" with the **same order id**. There's no second **Place order** to press.
- [ ] **🖱** Open http://localhost:3000: **Seat unavailable** (it's sold).

### T16 · Two devices pressing at the same moment: idempotent replay

1. **⌨️** Reset:
   ```bash
   curl -s -X POST localhost:4000/dev/reset -H 'content-type: application/json' -d '{}'
   ```
2. **🖱** http://localhost:3000 → **Start checkout** → **Side-by-side demo** (link under the card).
3. **🖱** In the **web** frame (left), press **Continue to payment**. Then click once anywhere inside
   the **mobile** frame (right). Both frames now show **Place order**.
4. **🖱** Press **⚡ Race both surfaces** in the toolbar at the top.

**Expected**
- [ ] One frame: "You're going! Order confirmed". The other: **"Already purchased · This order was
      already placed from another device. You were charged once."**
- [ ] The **same order id** in both frames.
- [ ] Analytics: one `status_completed` and one `checkout_replayed` for this session.

---

## 10. Instrumentation · *brief: "How would you instrument this flow to know whether continuity improves checkout conversion?"*

### T17 · Read the funnel

Reset doesn't clear analytics, so the funnel accumulates everything since `npm run dev` started.
For a clean read, restart the servers first (`Ctrl+C` in Tab 1, then `npm run dev`).

1. **🖱** Run **T15** (a purchase that moves across surfaces).
2. **🖱** Run **T9** steps 1–4 (a single-surface expiry).
3. **🖱** Open http://localhost:4000/dev/analytics.

**Expected** in `funnel`:
- [ ] `sessions: 2`, `completed: 1`.
- [ ] `crossSurface: { sessions: 1, completed: 1, conversion: 1 }` and
      `singleSurface: { sessions: 1, completed: 0, conversion: 0 }`. Conversion split by whether the
      fan continued on another device is the answer to the brief's question.
- [ ] `expired: 1`, plus `priceBanner`, `failed` and `replayedRequests` counters.

---

## 11. Resilience (optional)

### T18 · API down → a friendly error, not a stack trace

1. **⌨️** Stop **only** the API process (the web server keeps running):
   ```bash
   lsof -ti tcp:4000 -sTCP:LISTEN | xargs kill
   ```
   The `-sTCP:LISTEN` part matters: without it, `lsof` also matches the Next server, which holds
   connections to the API.
2. **🖱** Load any `/checkout/cs_…` URL, e.g. http://localhost:3000/checkout/cs_test.

**Expected**
- [ ] "We couldn't load your checkout · Loading a page never charges you…" and **Try again**.
      (In dev, Next's error overlay may also appear on top.)
3. **⌨️** Restart everything: in **Tab 1**, press `Ctrl+C`, then:
   ```bash
   npm run dev
   ```

---

## Coverage: brief → tests

| Brief says | Manual | Automated |
|---|---|---|
| Create a checkout session for a selected listing | T1 | `app.test.ts` happy path |
| Resume from a second surface / deep-link route | T3, T4 | route tests; `surface_resumed` tests |
| ≥2 fan-facing state changes | T6–T8 price, T9–T11 expiry, T13–T14 failure, T5 payment pending | machine matrix, view tests, route tests |
| Source of truth for session + expiration (backend) | T5, T9 | `evaluate` tests, transition matrix |
| Fast, stable web before JS | T2 | — (browser-verified) |
| Mobile opens same session via deep link; recovery states | T3, T10 | — (browser-verified) |
| Stale inventory never held forever | T11, T12, T13 | inventory exclusivity + lifecycle tests |
| Price change never hidden | T6, T7, T8 | view derivation tests; `PRICE_MISMATCH` route tests |
| No duplicate orders across devices | T15, T16 | `BarrierGateway` / `NaiveGateway` race tests |
| Instrumentation for conversion | T17 | `funnel.test.ts`; analytics route tests |
| Small API: create, resume, complete | T1, §1 script | `app.test.ts` |
| Cross-surface transitions visible in UI | T5, T7, T15, T16 | — |
| Tests or scripted scenarios | §1 | `npm test`, `scripts/demo-api.sh` |
