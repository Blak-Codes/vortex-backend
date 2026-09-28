# On-Call Runbook — Vortex Backend

> **Scope:** This document covers the two most common on-call scenarios for
> `vortex-backend`: (1) Soroban RPC dependency outages and (2) a stuck or
> slow intent sweeper.  
> Last updated: 2026-08-30

---

## Table of Contents

1. [Service overview](#service-overview)
2. [What "normal" looks like](#what-normal-looks-like)
3. [SLOs and burn-rate alerts](#slos-and-burn-rate-alerts)
4. [Scenario A — Soroban RPC downtime](#scenario-a--soroban-rpc-downtime)
5. [Scenario B — Stuck or slow sweeper](#scenario-b--stuck-or-slow-sweeper)
6. [Scenario C — Guardian emergency action](#scenario-c--guardian-emergency-action)
7. [Scenario D — Synthetic canary failing](#scenario-d--synthetic-canary-failing)
8. [Key configuration](#key-configuration)
9. [Escalation path](#escalation-path)

---

## Service overview

`vortex-backend` is a NestJS HTTP + WebSocket service that:

- Accepts swap intents from users via `POST /api/v1/intents`
- Brokers them to solvers over a WebSocket feed (`WS /ws`)
- Reads chain state from a Soroban RPC node (`/api/v1/chain/*`)
- Expires stale open intents every 30 seconds via `IntentsSweeperService`

The HTTP/WS core is **fully in-memory** — a Soroban RPC outage degrades chain
read endpoints but does **not** take down the intent relay or WebSocket feed.

---

## What "normal" looks like

| Signal | Healthy value |
|---|---|
| `GET /health` | `200 { status: "ok" }` |
| `GET /api/v1/chain/health` | `200` with Soroban `status: "healthy"` |
| Sweeper log (every 30 s) | Debug line: `sweep complete: expired=N duration=Xms` |
| `vortex_sweeper_sweep_duration_ms` p99 | < 50 ms under normal load |
| `vortex_sweeper_expired_total` | Monotonically increasing; spikes expected near intent `deadline` clusters |
| WS subscriber count | Stable or slowly growing; sudden drops indicate client-side churn |
| Node.js heap | Steady-state < 200 MB; no sustained upward trend between GC cycles |

---

## SLOs and burn-rate alerts (issue #480)

Definitions: `ops/slo/slos.yaml` (OpenSLO). Generated rules:
`ops/prometheus/rules/vortex-slo.yml`, tested by `vortex-slo_test.yml`.

| SLO | Objective | Alert |
|---|---|---|
| Relay availability | 99.9% non-5xx / 30d | `VortexHighBurnRate` (page, 1h/5m) / `VortexSlowBurnRate` (ticket, 6h/30m) |
| Intent-create latency | p95 < 500ms / 7d | `VortexCreateLatencyHigh` (ticket) |
| WS delivery latency | p95 < 1s / 7d | covered by availability burn + `vortex:ws:p95_5m` recording rule |
| Event-ingestion lag | < 30s 99% / 7d | `VortexIngestionLagHigh` (page) |
| Tx confirmation latency | p95 < 60s / 7d | `vortex:confirm:p95_5m` recording rule, ticket on sustained breach |

SLIs: `vortex_http_requests_total`, `vortex_intent_create_duration_seconds`,
`vortex_ws_delivery_duration_seconds`, `vortex_event_ingestion_lag_seconds`,
`vortex_tx_confirmation_duration_seconds` (see `src/metrics/metrics.service.ts`).
Fast-burn alerts require a minimum throughput (`>100 events/h`) so low-traffic
periods do not page.

---

## Scenario A — Soroban RPC downtime

### Symptoms

- `GET /api/v1/chain/health` returns `502 Bad Gateway` or hangs.
- `GET /api/v1/chain/ledger` / `GET /api/v1/chain/network` return 5xx.
- Logs contain repeated errors from `SorobanRpc.Server`:
  ```
  Error: Network error: failed to fetch
  // or
  Error: Response code 503 (Service Unavailable)
  ```
- `GET /api/v1/chain/account/:key` returns 5xx.

### Impact

| Affected | Not affected |
|---|---|
| `/api/v1/chain/*` read endpoints | `/api/v1/intents` CRUD |
| On-chain account lookups | `WS /ws` intent feed |
| Future on-chain writes (roadmap) | Sweeper — runs entirely in-memory |

The intent relay continues operating. Users and solvers can still submit and
fill intents. Only chain-read features are degraded.

### Diagnosis steps

1. **Confirm it is the upstream RPC**, not the service itself:
   ```bash
   curl -s https://soroban-testnet.stellar.org/health
   # should return {"status":"healthy"}
   ```
   Check the [Stellar Status page](https://status.stellar.org) for ongoing
   incidents.

2. **Check `SOROBAN_RPC_URL` is correct** in the running environment:
   ```bash
   # In the container / pod
   echo $SOROBAN_RPC_URL
   ```
   The default is `https://soroban-testnet.stellar.org`.

3. **Check DNS** from inside the container:
   ```bash
   nslookup soroban-testnet.stellar.org
   ```

4. **Check logs** for the first occurrence of the error to determine onset:
   ```bash
   grep -i "soroban\|rpc\|stellar" /var/log/vortex-backend.log | tail -40
   ```

### Remediation

| Action | Command / step |
|---|---|
| Switch to a backup RPC endpoint | Set `SOROBAN_RPC_URL` and restart the service |
| Temporarily suppress 5xx alerts for chain endpoints | Add a monitoring exception for `/api/v1/chain/*` |
| Communicate to users | Post a degradation notice; intent relay is unaffected |

### Recovery confirmation

```bash
curl -s http://localhost:4000/api/v1/chain/health
# expect: {"status":"healthy",...}
```

---

## Scenario B — Stuck or slow sweeper

### Symptoms

- No `sweep complete` debug log for > 60 seconds (two missed intervals).
- Sweep duration metrics (`sweepDurationMs`) show p99 > 1 second.
- Open intents with `deadline` in the past are not transitioning to `expired`.
- WS clients are not receiving `intent_expired` events.
- CPU spike coincident with sweeper interval (every 30 s).

### What a healthy sweep looks like in logs

```
[IntentsSweeperService] sweep complete: expired=0 duration=2ms totalExpired=42
```

A sweep that has been delayed or killed will simply be absent.

### How the sweeper works

`IntentsSweeperService.sweep()` is triggered by a `setInterval` every
`SWEEP_INTERVAL_MS` (30 000 ms, hardcoded).  It:

1. Calls `IntentsService.getByState("open")` — iterates the in-memory store.
2. Compares each intent's `deadline` (Unix timestamp) against `Date.now()`.
3. Calls `IntentsService.update()` and `IntentsGateway.broadcast()` for each
   expired intent.
4. Records `vortex_sweeper_sweep_duration_ms` and increments
   `vortex_sweeper_expired_total` via `MetricsService.recordSweep()` (Prometheus,
   exposed on `GET /metrics`). The retired `MetricsRegistry` from
   `src/common/metrics.ts` has been removed (issue #259) — use the
   Prometheus metric names above for alerting and dashboards.

Because the store is in-memory and the loop is synchronous, the sweep should
complete in **single-digit milliseconds** for < 10 000 open intents.

### Possible causes and fixes

| Cause | Indicator | Fix |
|---|---|---|
| Node.js event loop blocked | Sweep log missing, but service still responding to HTTP | Profile with `clinic flame` or `node --prof`; identify the blocking call |
| `setInterval` not firing (module destroyed prematurely) | `onModuleDestroy` called without `onModuleInit` | Investigate graceful-shutdown lifecycle; restart the process |
| Runaway open-intent accumulation | `IntentsService.getByState("open")` returning tens of thousands of items | Investigate why intents are not being filled/cancelled; a per-user cap of **50 simultaneous open/accepted intents** (`MAX_OPEN_INTENTS_PER_USER` in `src/intents/intents.service.ts`) is enforced at creation time — if you see accumulation beyond this per-user limit investigate whether the cap enforcement path (HTTP 409 on `POST /api/v1/intents`) is reachable, or whether old seed/test data was inserted directly into the store |
| Broadcast fan-out stalling | `IntentsGateway.broadcast()` slow due to thousands of WS subscribers | Reduce subscriber count or move to async fan-out; see issue #84 load-test results |
| Clock skew | All intents appear non-expired despite past deadlines | Verify `Date.now()` on the server and compare against intent `deadline` values; fix NTP |

### Manual sweep trigger (emergency)

The service installs a **`SIGUSR2` handler** that runs exactly one
`IntentsSweeperService.sweep()` cycle on demand. This is the supported
break-glass mechanism — do **not** attach a Node.js REPL to the process.

**Why a signal and not an HTTP endpoint:** it requires shell access to the
host (so it is inherently operator-only and unreachable by any API client),
needs no separate secret to manage, and every invocation is logged loudly so
it shows up clearly in the incident timeline.

```bash
# 1. Find the backend PID
pgrep -f "node dist/main.js"

# 2. Trigger one sweep cycle
kill -USR2 <pid>
#   In Kubernetes:
#   kubectl exec <pod> -- kill -USR2 1
```

The trigger is synchronous and idempotent — sending `SIGUSR2` again simply
runs another cycle. Confirm it ran by grepping the logs:

```bash
grep "MANUAL SWEEP" /var/log/vortex-backend.log | tail -5
# [sweeper] MANUAL SWEEP TRIGGERED (source=SIGUSR2, invokedAt=...) — running one sweep cycle
# [sweeper] MANUAL SWEEP COMPLETE (source=SIGUSR2, invokedAt=...): expired=N slashed=M duration=Xms
```

If a manual sweep is needed repeatedly, the sweeper's own 30-second interval
is broken — escalate to the service owner rather than scripting the signal.

### Diagnosis steps

1. **Check the last sweep timestamp** in logs:
   ```bash
   grep "sweep complete" /var/log/vortex-backend.log | tail -5
   ```

2. **Check current open-intent count** via the API:
   ```bash
   curl -s http://localhost:4000/api/v1/intents/open | jq '.intents | length'
   ```
   A very large number (> 1 000) with many past-deadline entries confirms the
   sweeper is not running.

3. **Check metrics** (if a metrics endpoint is wired up):
   ```bash
   curl -s http://localhost:4000/metrics | grep sweeper
   # vortex_sweeper_sweep_duration_ms_count
   # vortex_sweeper_sweep_duration_ms_sum
   # vortex_sweeper_expired_total
   ```

4. **Inspect process health**:
   ```bash
   # CPU and memory
   top -p $(pgrep -f "node dist/main.js")

   # Open file descriptors (WS connections count as FDs)
   ls /proc/$(pgrep -f "node dist/main.js")/fd | wc -l
   ```

### Recovery confirmation

After a restart or fix, confirm:

```bash
# 1. Service is responding
curl -s http://localhost:4000/health

# 2. Sweep fires within 30 s — watch for the log line
journalctl -fu vortex-backend | grep "sweep complete"

# 3. Past-deadline intents are now expired
curl -s http://localhost:4000/api/v1/intents?state=open | jq '[.intents[] | select(.deadline < now)] | length'
# should be 0
```

---

## Scenario C — Guardian emergency action

The backend ingests emergency actions from the on-chain guardian / security
council contract (`GUARDIAN_CONTRACT_ID`, issue #507) and applies them within
one poll (10 s) on every instance:

| Guardian event | Backend effect |
|---|---|
| `guardian_pause` / `guardian_unpause` | Kill switch: `POST /api/v1/intents`, `/:id/accept`, `/:id/fill` return **503**. Cancels still work. |
| `guardian_freeze` / `guardian_unfreeze` (target = flag key or `*`) | Runtime feature flag changes for that key return **409**. |
| `guardian_blacklist` / `guardian_unblacklist` (target = solver) | Solver cannot accept intents (**403**); operator reactivation returns **409**. |

### Check status

```bash
curl -s http://localhost:4000/api/v1/governance/guardian/status | jq
# { paused, pauseSources: ["guardian","operator"], guardianActions: [{ id, kind, target, txHash, ledger, activatedAt }], ... }
```

Every active action carries its `txHash` — confirm it on a block explorer
before acting.

### Rules while a guardian action is active

- Guardian state is **authoritative**. Operators cannot clear it: operator
  resume, solver reactivation and flag edits on a frozen key are refused.
- Pause is the OR of sources. A guardian unpause while an operator pause is
  active leaves the protocol paused (and vice versa) — **both must clear**.

```bash
# Operator pause / resume (admin role; resume leaves any guardian pause in place)
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"reason":"incident INC-123"}' http://localhost:4000/admin/killswitch/pause
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"reason":"resolved"}' http://localhost:4000/admin/killswitch/resume
```

### Manual override (break-glass)

Only for a confirmed false positive, with sign-off from the security council.
Requires a **superadmin** key and is refused unless the audit record is
written (`admin_audit_log`, action `guardian.override`):

```bash
curl -X POST -H "x-admin-key: $SUPERADMIN_KEY" -H 'content-type: application/json' \
  -d '{"reason":"false positive, council ack in #sec-incident"}' \
  http://localhost:4000/api/v1/governance/guardian/actions/<actionId>/override
```

The override lasts until the guardian emits a new action for the same target.

---

## Scenario D — Synthetic canary failing

Alerts `VortexCanaryConsecutiveFailures`, `VortexCanaryFundsLow`,
`VortexCanaryBudgetExceeded` come from the canary CronJob
(`tools/canary/`, issue #496).

1. Check `vortex_canary_step_duration_seconds{step=...}` for the last step
   that reported — the failing step is the one after it — and the CronJob pod
   logs (`[canary] FAILED ...` names the HTTP call and status).
2. `create`/`accept`/`fill` returning 503 → check Scenario C (paused).
3. `fill` failing on-chain → canary funds or trustline issue; check
   `vortex_canary_balance_xlm`.
4. Funds low / budget exceeded → suspend the CronJob
   (`kubectl patch cronjob <name> -p '{"spec":{"suspend":true}}'`), top up the
   canary solver account, investigate fee spikes before resuming.

Canary intents are excluded from public stats and leaderboards via
`CANARY_ADDRESSES`; if they show up there, that variable is missing on the API.

---

## Key configuration

| Variable | Default | Effect |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Upstream Soroban JSON-RPC endpoint |
| `STELLAR_NETWORK` | `testnet` | Network passphrase selection |
| `PORT` | `4000` | HTTP + WS listen port |
| `NODE_ENV` | `development` | Log verbosity (set to `production` in prod) |
| `SWEEP_INTERVAL_MS` | `30000` (hardcoded) | How often the sweeper runs; change requires code deploy |
| `GUARDIAN_CONTRACT_ID` | empty (disabled) | Guardian contract polled for emergency actions |
| `ADMIN_API_KEYS` | empty (admin APIs disabled) | `id:role:secret` entries for admin / superadmin endpoints |
| `PROCESS_ROLE` / `JOBS_DRIVER` | `all` / `memory` | Where job workers run; `bullmq` for multi-instance |
| `CANARY_ADDRESSES` | empty | Canary accounts excluded from public stats |

---

## Escalation path

1. **On-call engineer** — check this runbook and attempt the listed remediation steps.
2. **Service owner** — if the sweeper is structurally broken (not just slow) or if the Soroban outage persists > 30 minutes.
3. **Stellar / Horizon team** — if `soroban-testnet.stellar.org` is confirmed down; follow [Stellar Discord #dev-support](https://discord.gg/stellardev).

> For production incidents open a severity-1 ticket and page the service owner
> via the alerting system.
