import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import client from "prom-client";
import { AppConfig } from "../config/configuration";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestTotal: client.Counter<string>;
  public readonly httpRequestErrors: client.Counter<string>;
  public readonly intentStateTransitions: client.Counter<string>;
  public readonly wsConnections: client.Gauge<string>;
  public readonly intentCreateDuration: client.Histogram<string>;
  public readonly wsDeliveryDuration: client.Histogram<string>;
  public readonly eventIngestionLag: client.Gauge<string>;
  public readonly txConfirmationDuration: client.Histogram<string>;

  /** Background job metrics (issue #494). */
  public readonly jobsQueueDepth: client.Gauge<string>;
  public readonly jobsDuration: client.Histogram<string>;
  public readonly jobsFailures: client.Counter<string>;
  public readonly jobsDeadLettered: client.Counter<string>;
  private queueDepthProvider?: () => Promise<Array<{ queue: string; state: string; count: number }>>;

  /** Feature-flag evaluations (issue #495). */
  public readonly flagEvaluations: client.Counter<string>;

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.register = new client.Registry();
    const prefix = "vortex_";

    this.httpRequestDuration = new client.Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.httpRequestTotal = new client.Counter({
      name: `${prefix}http_requests_total`,
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.httpRequestErrors = new client.Counter({
      name: `${prefix}http_request_errors_total`,
      help: "Total number of HTTP request errors (5xx)",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.intentStateTransitions = new client.Counter({
      name: `${prefix}intent_state_transitions_total`,
      help: "Total number of intent state transitions",
      labelNames: ["from_state", "to_state"],
      registers: [this.register],
    });

    this.wsConnections = new client.Gauge({
      name: `${prefix}ws_connections_active`,
      help: "Number of active WebSocket connections",
      registers: [this.register],
    });

    // ── Sweeper metrics (issue #259) ─────────────────────────────────────────
    // These replace the retired MetricsRegistry.sweeper namespace from
    // src/common/metrics.ts. They are Prometheus-backed so they appear in
    // GET /metrics and in any Prometheus/Grafana dashboards without further
    // adaptation.

    this.sweeperExpiredTotal = new client.Counter({
      name: `${prefix}sweeper_expired_total`,
      help: "Total number of intents expired across all sweeps",
      registers: [this.register],
    });

    this.sweeperSweepDurationMs = new client.Histogram({
      name: `${prefix}sweeper_sweep_duration_ms`,
      help: "Duration of each IntentsSweeperService.sweep() execution in milliseconds",
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.register],
    });

    // ── SLO SLIs (issue #480) ───────────────────────────────────────────────
    this.intentCreateDuration = new client.Histogram({
      name: `${prefix}intent_create_duration_seconds`,
      help: "Intent-create handler latency in seconds",
      labelNames: ["route"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.wsDeliveryDuration = new client.Histogram({
      name: `${prefix}ws_delivery_duration_seconds`,
      help: "WS end-to-end delivery latency (broadcast to send) in seconds",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.eventIngestionLag = new client.Gauge({
      name: `${prefix}event_ingestion_lag_seconds`,
      help: "Event-ingestion lag: now minus newest ingested event timestamp",
      registers: [this.register],
    });

    this.txConfirmationDuration = new client.Histogram({
      name: `${prefix}tx_confirmation_duration_seconds`,
      help: "Fill submission to on-chain confirmation latency in seconds",
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers: [this.register],
    });

    // ── Background jobs (issue #494) ────────────────────────────────────────
    // Depth is sampled on scrape from the active queue driver, so it reflects
    // every instance's shared view of the queue (BullMQ) without a timer.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.jobsQueueDepth = new client.Gauge({
      name: `${prefix}jobs_queue_depth`,
      help: "Jobs per queue and state (waiting, active, delayed, dead_letter)",
      labelNames: ["queue", "state"],
      registers: [this.register],
      async collect() {
        if (!self.queueDepthProvider) return;
        this.reset();
        for (const { queue, state, count } of await self.queueDepthProvider()) {
          this.set({ queue, state }, count);
        }
      },
    });

    this.jobsDuration = new client.Histogram({
      name: `${prefix}jobs_duration_seconds`,
      help: "Job handler latency in seconds",
      labelNames: ["queue", "job", "outcome"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
      registers: [this.register],
    });

    this.jobsFailures = new client.Counter({
      name: `${prefix}jobs_failures_total`,
      help: "Failed job attempts (including ones that will be retried)",
      labelNames: ["queue", "job"],
      registers: [this.register],
    });

    this.jobsDeadLettered = new client.Counter({
      name: `${prefix}jobs_dead_lettered_total`,
      help: "Jobs moved to the dead-letter queue after exhausting retries",
      labelNames: ["queue", "job"],
      registers: [this.register],
    });

    // ── Feature flags (issue #495) ──────────────────────────────────────────
    this.flagEvaluations = new client.Counter({
      name: `${prefix}flag_evaluations_total`,
      help: "Feature-flag evaluations by flag, resolved value and reason",
      labelNames: ["flag", "value", "reason"],
      registers: [this.register],
    });
  }

  /** Registers the source sampled for `vortex_jobs_queue_depth` on each scrape. */
  setQueueDepthProvider(
    provider: () => Promise<Array<{ queue: string; state: string; count: number }>>,
  ): void {
    this.queueDepthProvider = provider;
  }

  onModuleInit() {
    const prefix = "vortex_";
    client.collectDefaultMetrics({ register: this.register, prefix });
  }

  async metrics(): Promise<string> {
    return this.register.metrics();
  }

  contentType(): string {
    return this.register.contentType;
  }

  incIntentStateTransition(from: string, to: string) {
    this.intentStateTransitions.inc({ from_state: from, to_state: to });
  }

  incWsConnection() {
    this.wsConnections.inc();
  }

  decWsConnection() {
    this.wsConnections.dec();
  }

  /**
   * Record one sweeper cycle's expired count and duration.
   * Called by IntentsSweeperService at the end of every sweep() invocation.
   */
  recordSweep(expiredCount: number, durationMs: number): void {
    this.sweeperExpiredTotal.inc(expiredCount);
    this.sweeperSweepDurationMs.observe(durationMs);
  }

  /**
   * Observe intent-create latency (SLO SLI, issue #480).
   * Call from the create path with handler duration in seconds.
   */
  observeIntentCreate(durationSeconds: number, route = "POST /api/v1/intents"): void {
    this.intentCreateDuration.observe({ route }, durationSeconds);
  }

  /**
   * Observe WS end-to-end delivery latency (SLO SLI, issue #480).
   * Call from the gateway broadcast path with queue-to-send duration.
   */
  observeWsDelivery(durationSeconds: number): void {
    this.wsDeliveryDuration.observe(durationSeconds);
  }

  /** Set current event-ingestion lag in seconds (SLO SLI, issue #480). */
  setIngestionLag(lagSeconds: number): void {
    this.eventIngestionLag.set(lagSeconds);
  }

  /** Observe fill-to-confirmation latency in seconds (SLO SLI, issue #480). */
  observeTxConfirmation(durationSeconds: number): void {
    this.txConfirmationDuration.observe(durationSeconds);
  }
}
