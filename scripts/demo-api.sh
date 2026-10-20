#!/usr/bin/env bash
# Walks the API through the three scenarios against a running dev server
# (npm run dev -w @seatkeeper/api). Uses the /dev levers to bump price / skip time.
set -euo pipefail
A=${API_URL:-http://localhost:4000}

post() { curl -s -H 'content-type: application/json' -X POST "$A$1" -d "$2"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0)).session.$1"; }
show() {
  node -e '
    let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
      const j = JSON.parse(d), s = j.session || {};
      if (!j.session) return console.log("✗ " + j.error);
      console.log((j.error ? "✗ " + j.error.padEnd(18) : "✓ ".padEnd(20)) +
        `status=${s.status} v=${s.version} priceAtStart=${s.priceAtStart} currentPrice=${s.currentPrice}` +
        (s.orderId ? ` order=${s.orderId}` : "") + (j.replayed ? "  [replayed]" : ""));
    })'
}
new_session() { post /checkout '{"listingId":"lst_heat_1"}'; }
# Seats are exclusive and completed scenarios really sell them: reset between scenarios.
reset() { post /dev/reset '{}' >/dev/null; }

reset
echo "── 1. Price change ────────────────────────────────────────────"
R=$(new_session); ID=$(echo "$R" | field id); KEY=$(echo "$R" | field idempotencyKey)
printf '%-28s' "create";                echo "$R" | show
post /dev/listings/lst_heat_1/price '{"price":21000}' >/dev/null
printf '%-28s' "resume after price bump";  curl -s "$A/checkout/$ID" | show
printf '%-28s' "stale pay (v1 @ 18500)";   post "/checkout/$ID/pay" '{"expectedVersion":1,"acceptedPrice":18500}' | show
printf '%-28s' "fresh v, old price";       post "/checkout/$ID/pay" '{"expectedVersion":2,"acceptedPrice":18500}' | show
printf '%-28s' "acknowledged (v2 @ 21000)"; post "/checkout/$ID/pay" '{"expectedVersion":2,"acceptedPrice":21000}' | show
printf '%-28s' "complete";                 post "/checkout/$ID/complete" "{\"expectedVersion\":3,\"idempotencyKey\":\"$KEY\",\"acceptedPrice\":21000}" | show

reset
echo; echo "── 2. Expiration ──────────────────────────────────────────────"
ID=$(new_session | field id)
post /dev/clock/advance '{"ms":300000}' >/dev/null
printf '%-28s' "resume after TTL";  curl -s "$A/checkout/$ID" | show
printf '%-28s' "pay anyway";        post "/checkout/$ID/pay" '{"expectedVersion":2,"acceptedPrice":18500}' | show

reset
echo; echo "── 3. Two surfaces complete at the same time ───────────────────"
R=$(new_session); ID=$(echo "$R" | field id); KEY=$(echo "$R" | field idempotencyKey)
post "/checkout/$ID/pay" '{"expectedVersion":1,"acceptedPrice":18500}' >/dev/null
BODY="{\"expectedVersion\":2,\"idempotencyKey\":\"$KEY\",\"acceptedPrice\":18500}"
TMP=$(mktemp -d)
post "/checkout/$ID/complete" "$BODY" > "$TMP/web" &
post "/checkout/$ID/complete" "$BODY" > "$TMP/mobile" &
wait
printf '%-28s' "web completes (v2)";    show < "$TMP/web"
printf '%-28s' "mobile completes (v2)"; show < "$TMP/mobile"
rm -rf "$TMP"

reset
echo; echo "── 4. Two fans, one seat ───────────────────────────────────────"
printf '%-28s' "fan A starts";  new_session | show
printf '%-28s' "fan B starts";  new_session | show
reset
