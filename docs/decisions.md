# Decisions

Why things are the way they are. Newest first.

## 2026-09-04 — verifyOtp burns a dummy bcrypt hash when no OTP is pending

**Problem.** `GENERIC_VERIFY_ERROR` returns one identical message for wrong,
expired, consumed, exhausted, and never-existed — so the response body leaks
nothing. The clock leaked it anyway. When a pending OTP existed, `verifyOtp`
spent ~100ms in `bcrypt.compare`; when none did, it returned straight after the
`findFirst`. An attacker submitting `000000` to a list of numbers and timing the
responses learns which ones have a live OTP — precisely the fact the uniform
message exists to hide.

**Fix.** A module-level `DUMMY_HASH`, compared against and discarded on the
no-record path before throwing. Measured gap closes from 85ms to under 50ms.

**The dummy hash is generated at boot, not hardcoded.** `bcrypt.compare`
rejects a malformed hash immediately, so a hardcoded constant that is subtly
wrong reintroduces the exact fast path this exists to remove — and it would
still pass any test that only asserts the call rejects. Deriving it from
`SALT_ROUNDS` also keeps the dummy comparison exactly as expensive as a real one
if that constant is ever raised. Costs one hash (~100ms) at startup, once.

**Note.** The test file's `$2a$10$placeholderplaceholder...` constant is *not*
valid bcrypt. It is fine as a column filler for seeded rows, but it would have
been useless here for the reason above.

**Verified red first.** With the `bcrypt.compare(code, DUMMY_HASH)` line
commented out, the new test fails with `expected 85 to be less than 50` — an
85ms gap, matching the predicted bcrypt cost. Restored, it passes. Full suite:
75 passed.

**Residual, accepted.** The wrong-code path still does an `attempts` increment
the no-pending path skips — one extra round trip. Sub-millisecond against local
Postgres, so it sits far inside the 50ms bound. Worth remembering that this test
only became viable when the test database moved local; against a remote database
that round trip alone was ~60ms and the test would have been permanently flaky.

**Does not cover.** Timing differences above the application — TLS, the pooler,
network jitter — are not measurable or controllable here and are not the channel
an attacker would use anyway.


## 2026-09-04 — Test database is local Postgres in Docker, not a cloud branch

**Problem.** A test run failed with `err.statusCode === undefined` — no status
at all, meaning something threw that was not an `AppError`. Two separate causes,
both of which existed because the test database was a remote Neon branch:

1. `add_send_failed` had been applied to the *production* branch and not to the
   test branch. `prisma.config.ts` does `import 'dotenv/config'`, which loads
   `.env` and nothing else, so `prisma migrate dev` silently targeted
   production. The test branch had no `sendFailed` column.
2. The generated Prisma client was stale — schema edited 09-03, client last
   generated 09-01. `data: { sendFailed: true }` was an unknown argument.

Neither failure surfaced as a status code, which is why the symptom was
`undefined` rather than a 502.

**Fix.** Local Postgres 16 in Docker — container `salira-test-db`, host port
5433 mapped to 5432, database `salira_test`. `.env.test` points at it and is
loaded by `vitest.config.js`. `dotenv-cli` added as a dev dependency so Prisma
commands can be aimed at a specific env file.

**Why local rather than a second cloud branch.**
- The round trip is sub-millisecond, so the suite is bounded by bcrypt rather
  than the network. A full run was 95s against Neon.
- `beforeEach` calls `deleteMany({})`. That is correct for a test database and
  catastrophic against anything shared — a cloud test branch is one wrong
  `DATABASE_URL` away from being a data-loss incident. `.env.test` now says so
  in a comment at the top.
- Nobody can wipe a shared database by running `npm test`.

**Changed as a result.**
- `vitest.config.js` — `testTimeout` 90s → 10s, `hookTimeout` 60s → 10s

**The trap that caused this, stated plainly.** `prisma.config.ts` loads `.env`
only. Every `prisma migrate` command targets the production database unless the
variable is overridden on the command line. To act on the test database:

```
npx dotenv -e .env.test -- npx prisma migrate status
npx dotenv -e .env.test -- npx prisma migrate deploy
```

Run `migrate status` before assuming any database is current. Verified
2026-09-04: `salira_test` reports all 3 migrations applied.

**Practice going forward.** `npx prisma generate` after every schema edit. A
stale client fails as a validation error with no HTTP status, which reads like
a test bug rather than a build step that was skipped.

**Outcome.** Full suite against the local database: 75 passed, 11.5s — down from
95s. The 5 failures seen beforehand were entirely artifacts of the old remote
test branch (missing `sendFailed` column, plus the stale client). In particular
`rate limits are per-phone, not global`, which was failing with a P2034 write
conflict on a *sequential* call, has not reappeared: on a sub-millisecond
connection the Serializable transaction commits far too quickly to collide.
There was no bug to find — the write conflicts were an artifact of holding the
transaction open across ~60ms round trips.

**Open.** No npm script wires `dotenv-cli` yet — the commands above are manual.


## 2026-09-04 — Moved Postgres from Neon (Singapore) to Supabase (Mumbai)

**Problem.** Yesterday's move to Singapore cut the round trip to ~110ms, but
`requestOtp` is a five-round-trip Serializable transaction, so it still cost
~330ms of pure network before bcrypt. India is the entire customer base and
Neon has no India region.

**Fix.** Supabase project in `aws-ap-south-1` (Mumbai), reached through the
Supavisor session pooler at `aws-0-ap-south-1.pooler.supabase.com:5432`.

**Measured** (from the dev laptop, 2026-09-04):

| | Neon Singapore | Supabase Mumbai |
|---|---|---|
| Warm round trip | ~110ms | 66ms median (59–66) |
| Cold connect | ~900ms | 492ms |
| TCP handshake alone | — | 66–98ms |
| DNS | — | 60ms |

Region confirmed rather than assumed: A records `3.111.105.85` /
`65.0.195.55` are AWS ap-south-1, and `inet_server_addr()` returns
`2406:da1a:...` (ap-south-1). Postgres 17.6.

**What this does not fix.** The remaining ~60ms is the last-mile ISP path from
the dev laptop to Mumbai, not distance to the datacenter — the raw TCP handshake
alone is 66ms, before any TLS or Postgres protocol. No provider or region change
reduces it further. Latency measured from a laptop is not the production number:
with the API in ap-south-1 the round trip should be 1–2ms.

**Cold connect is ~8 round trips**, not one: TCP (1) + TLS (2) + Postgres
startup and SCRAM-SHA-256 auth (3) + Supavisor opening its own upstream
connection to Postgres. This is why `min: 2` and `warmDbPool()` stay — they are
the reason the observed median is 66ms and not 500ms.

**Changed as a result.**
- `.env` — `DATABASE_URL` → Supabase pooler, with `?sslmode=require`
- `.env.example` — same, with a note on why `sslmode` is not optional
- `prisma.config.ts` — datasource back to `env('DATABASE_URL')`; Supabase
  exposes no separate direct/unpooled URL in this setup
- `config/db.js` — `connectionTimeoutMillis` 15s → 5s

**Security regression found and fixed.** The first Supabase URL carried no
`sslmode`. node-postgres defaults to no TLS and Supavisor accepts plaintext —
confirmed by connecting with the app's exact connection string and reading
`stream.encrypted === false`. The database password and every query, including
phone numbers and OTP hashes, crossed the public internet in cleartext. The old
Neon URL had `sslmode=verify-full&channel_binding=require`; that protection was
dropped in the move and nothing complained. TLS costs ~100ms once per connection
(444ms plaintext connect vs 542ms with TLS) and nothing per query.

**Open.** Rotate the Supabase password — it was exposed in cleartext.
`sslmode=require` encrypts but does not verify the server certificate
(node-postgres maps it to `rejectUnauthorized: false`), so it stops passive
eavesdropping, not an active MITM. `verify-full` needs Supabase's CA cert
referenced via `sslrootcert=`.

**Deliberately kept.**
- Session pooler on 5432 rather than transaction mode on 6543. Transaction mode
  addresses connection count, not latency, and would require `pgbouncer=true`
  and the loss of prepared statements.
- `min: 2` and `warmDbPool()`, for the reason above.

**Rejected.** Folding `requestOtp`'s `updateMany` + `create` into a single
data-modifying CTE. It removes one round trip — ~60ms from the dev laptop, but
~1–2ms from an API in ap-south-1, which is the only topology that matters. The
price is two type-checked Prisma calls becoming hand-written SQL that Prisma
cannot keep in sync: `@default(uuid())` is client-side, so the raw INSERT has to
supply the id, and a future required column would fail at runtime rather than at
build time. The latency win was quoted from the laptop; against the real number
it does not justify losing schema safety.


## 2026-09-03 — Moved Postgres from us-east-2 to ap-southeast-1

**Problem.** Transactional endpoints were failing in ways that made no sense.
Prisma's default `maxWait` (2s) was expiring before the transaction ran a
single query.

**Cause.** The Neon project was in AWS Ohio while development happens from
India — roughly 250ms per round trip. A three-query transaction was already
at ~2.7s before doing any work. TLS handshake (4–5 sequential round trips)
cost 3–5s on a cold connection.

**Fix.** New Neon project in `aws-ap-southeast-1` (Singapore). Neon has no
India region; Singapore is the closest. The API will be hosted in Singapore
too — colocation is the point, not the region name.

**Measured.**

| | Ohio | Singapore |
|---|---|---|
| Warm round trip (from dev) | ~900ms | ~110ms |
| Cold connect | 3–5s | ~900ms |
| `requestOtp` transaction | ~2.7s | ~330ms |

In production, with the API in the same region, the warm round trip should
be 1–3ms rather than 110ms.

**Changed as a result.**
- `vitest.config.js` — `testTimeout` 90s → 20s (slowest test is 8.6s)
- `config/db.js` — `connectionTimeoutMillis` 15s → 5s
- `otp.service.js` — `maxWait` 15s → 5s, `timeout` 15s → 8s

**Deliberately kept.**
- The `count(*) FILTER` aggregate in `requestOtp`. One query instead of
  three is correct regardless of latency — this was never a latency
  workaround.
- `min: 2` and `warmDbPool()`. The ~900ms cold connect is still real.
  Tradeoff: an always-warm pool keeps the Neon compute from suspending, so
  compute-hours accrue continuously. Watch usage on the free plan.

**Open.** Consider moving rate-limit counters to Redis, which would remove
the Serializable transaction from the login path entirely. Not urgent now
that a round trip is milliseconds.


## 2026-09-03 — Failed SMS sends no longer count against per-phone limits

**Problem.** When MSG91 fails, the user gets a 502 and is told to retry — then
the retry is refused with 429. Five failures in a row locks the number out for
an hour; fifteen locks it out for the day. All for an outage that was the
provider's fault, not the user's.

**Cause.** The catch block set `expiresAt: new Date()` on the failed row,
intending to cancel it. But the cooldown check filters on `verified` and
`createdAt`, never `expiresAt` — so the row was still counted. The hourly and
daily aggregates had no exclusion at all.

**Fix.** New `sendFailed` boolean on `OtpRequest`, set alongside `expiresAt` in
the catch block. Added `AND "sendFailed" = false` to the cooldown, hour, and day
FILTER clauses.

**Deliberately kept.**
- `expiresAt: new Date()` stays. It kills the code; `sendFailed` clears the
  rate-limit footprint. Two different jobs — dropping either reintroduces half
  the bug.
- The row is not deleted. `sendFailed = true` rows are the only record of how
  often MSG91 is failing us.
- The IP subquery does **not** exclude failed rows. A failed send still cost an
  API call, and excluding them would hand an attacker a free bypass of the
  distinct-phone cap.

**How it was missed.** The test named "does not strand the user in cooldown
after a failed send" called `backdate()` before retrying, shifting `createdAt`
65 seconds into the past. It passed for a reason unrelated to what it claimed to
test. Rewritten without the backdate; it now fails against the old code.

**Practice going forward.** When writing a test for a specific bug, run it
against the unfixed code first and confirm it goes red. A test that has never
failed has not been shown to test anything.

## 2026-09-02 — Rate limiting is per distinct phone per IP, not per request

**Problem.** SMS pumping. An attacker scripts `/request-otp`, each send costs
₹0.12–0.25, and they take a cut of the traffic revenue. Per-phone caps do
nothing: one request per number keeps every number inside every limit.

**Rejected.** A per-IP request counter (originally `max: 5` per 15 min). Two
reasons. It breaks real users — Jio and Airtel put large numbers of subscribers
behind CGNAT, so hundreds of unrelated customers share one public IP. And it
measures the wrong thing: what separates an attacker from a customer is how many
*different* numbers they touch, not how many requests they make.

**Fix.** `MAX_DISTINCT_PHONES_PER_IP_HOUR = 10`, enforced inside `requestOtp`'s
transaction as a scalar subquery in the existing aggregate — no extra round trip.
Coarse IP limiter raised to 30/15min as an outer net only.

**Deliberately kept.**
- The subquery excludes the requesting phone (`phone <> ${phone}`), so a user
  re-requesting their own code never consumes their own IP budget.
- `ip = NULL` matches nothing in SQL, so a missing IP skips the check rather
  than matching every null row. Fail-open is correct here — a missing IP should
  not lock anyone out.
- `normalizePhone` restricted to `/^[6-9]\d{9}$/`. This is the strongest
  protection in the file: premium international routes are where the money is,
  and we simply cannot send there. Do not loosen for international support
  without a separate per-country policy.

**Depends on.** `app.set('trust proxy', 1)` in `app.js`. Without it every
request reports the load balancer's address and the check is inert. Verify by
checking `OtpRequest.ip` is populated, not null.

**Does not stop.** A botnet or proxy pool — 10 numbers × 1000 IPs is still
10,000 sends. The country restriction and the sent-vs-verified ratio alarm are
the layers that matter there.