import * as Joi from "joi";

// Stellar secret seeds ("S..." strkeys) are 56-char base32: prefix + 32-byte
// payload + checksum. This rejects placeholders like "changeme" outright —
// it does not by itself prove the key is a *real, funded* signer.
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(4000),

  // Prisma requires DATABASE_URL in production; optional (with a default) in
  // development/test so the app can boot without a live database for unit tests.
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgresql", "postgres"] })
    .default("postgresql://vortex:vortex@localhost:5432/vortex?schema=public"),

  STELLAR_NETWORK: Joi.string().valid("testnet", "futurenet", "mainnet").default("testnet"),
  SOROBAN_RPC_URL: Joi.string().uri().default("https://soroban-testnet.stellar.org"),
  SETTLEMENT_CONTRACT_ID: Joi.string().allow("").default(""),
  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().allow("").default(""),
  STELLAR_SIGNER_SECRET_KEY: Joi.string().allow("").default(""),

  // Secret key for the backend's own Soroban signer (submits on-chain writes
  // such as settlement and slashing calls). No default is provided anywhere
  // in this schema — an unset value fails closed (empty string) rather than
  // ever falling back to a placeholder that could be mistaken for a real key.
  SOROBAN_SIGNING_KEY: Joi.string()
    .pattern(STELLAR_SECRET_KEY_PATTERN)
    .messages({
      "string.pattern.base":
        'SOROBAN_SIGNING_KEY must be a valid Stellar secret seed (starts with "S", 56 base32 characters). ' +
        "Generate a throwaway testnet key for local dev — see README's Signing Key section — never commit a real one.",
    })
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().allow("").default(""),
    }),

  ONCHAIN_INTENTS_ENABLED: Joi.boolean().default(false),
  CORS_ORIGIN: Joi.string().default("*"),
  WS_MAX_CONNECTIONS: Joi.number().integer().min(0).default(1000),
  SOROBAN_FEE_PERCENTILE: Joi.string()
    .valid(
      "min",
      "mode",
      "p10",
      "p20",
      "p30",
      "p40",
      "p50",
      "p60",
      "p70",
      "p80",
      "p90",
      "p95",
      "p99",
      "max",
    )
    .default("p50"),

  WS_BACKPLANE: Joi.string().valid("memory", "redis").default("memory"),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).default("redis://localhost:6379"),

  // ── Persistence adapter selection ─────────────────────────────────────────
  // Controls which repository adapter is used for intents and solvers.
  // "memory" (default) keeps everything in-process — no database required.
  // "prisma" writes to PostgreSQL via Prisma — requires DATABASE_URL to point
  // to a live database.  Intended for production / staging.
  INTENTS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),
  SOLVERS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

  // ── Observability ─────────────────────────────────────────────────────────
  // Sentry DSN for error alerting.  Omit (or leave blank) to disable Sentry.
  SENTRY_DSN: Joi.string().uri().allow("").default(""),

  // Winston log level.  Defaults to "debug" in dev/test and "info" in production.
  LOG_LEVEL: Joi.string()
    .valid("error", "warn", "info", "http", "verbose", "debug", "silly")
    .default(
      // Joi.ref doesn't evaluate lazily here, so we rely on the logger's own
      // resolveLogLevel() for the runtime default — this schema default acts
      // as a documentation hint and config validation guard only.
      "debug",
    ),

  // Log shipping — off by default so local dev/CI remain stdout-only. When
  // enabled, structured logs are also shipped to LOG_SHIPPING_HOST:PORT.
  LOG_SHIPPING_ENABLED: Joi.boolean().default(false),
  LOG_SHIPPING_HOST: Joi.string().when("LOG_SHIPPING_ENABLED", {
    is: true,
    then: Joi.required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  LOG_SHIPPING_PORT: Joi.number().port().when("LOG_SHIPPING_ENABLED", {
    is: true,
    then: Joi.required(),
    otherwise: Joi.number().optional(),
  }),
  LOG_SHIPPING_PATH: Joi.string().default("/"),
  LOG_SHIPPING_SSL: Joi.boolean().default(false),
  LOG_SERVICE_NAME: Joi.string().default("vortex-backend"),

  // ── On-chain write safety flag (issue #35 / issue #260) ──────────────────
  // When true, every on-chain-write code path (invokeContract, slashSolver)
  // builds and simulates the transaction, logs what it *would* submit, and
  // returns without broadcasting — safe by construction.
  //
  // Default behaviour:
  //   - Outside production: defaults to true (simulate-only, fail closed
  //     toward safety — no real funds moved without an explicit opt-out).
  //   - In production: *required* to be explicitly set.  Omitting it in a
  //     production deploy fails validation so the operator must consciously
  //     decide between dry-run and live mode before traffic reaches
  //     on-chain write paths.  This matches the fail-closed pattern used
  //     for SOROBAN_SIGNING_KEY.
  //
  // This is the env default for the `onchain-dry-run` runtime feature flag
  // (issue #495); the flag can override it without a restart, and turning
  // dry-run off in production through the flag requires two approvals.
  // Set ONCHAIN_DRY_RUN=false only after completing the dry-run soak
  // described in docs/runbooks/onchain-cutover.md.
  ONCHAIN_DRY_RUN: Joi.boolean()
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required().messages({
        "any.required":
          "ONCHAIN_DRY_RUN must be explicitly set in production. " +
          "Set to true to remain in simulate-only mode, or false to enable live on-chain writes. " +
          "See docs/runbooks/onchain-cutover.md for the staged rollout procedure.",
      }),
      otherwise: Joi.boolean().default(true),
    }),

  // ── Background jobs (issue #494) ──────────────────────────────────────────
  // PROCESS_ROLE: "api" serves HTTP/WS only, "worker" runs queue workers,
  // "all" does both (single-process dev default). Producers work in any role.
  PROCESS_ROLE: Joi.string().valid("api", "worker", "all").default("all"),
  // JOBS_DRIVER: "memory" is single-process and non-durable (dev/test);
  // "bullmq" uses REDIS_URL and is required for multi-instance deploys.
  JOBS_DRIVER: Joi.string().valid("memory", "bullmq").default("memory"),
  JOBS_SHUTDOWN_TIMEOUT_MS: Joi.number().integer().min(0).default(25000),

  // ── Runtime feature flags (issue #495) ────────────────────────────────────
  FLAGS_PUBSUB: Joi.string().valid("memory", "redis").default("memory"),
  FLAGS_REFRESH_MS: Joi.number().integer().min(1000).default(30000),
  // Comma-separated "key=true|false" pins that win over DB state (break-glass).
  FLAG_OVERRIDES: Joi.string()
    .allow("")
    .pattern(/^([a-z0-9-]+=(true|false))(,[a-z0-9-]+=(true|false))*$/)
    .default(""),

  // ── Admin RBAC ────────────────────────────────────────────────────────────
  // Comma-separated "id:role:secret" entries; role is "admin" or "superadmin".
  // Empty disables every admin endpoint (401).
  ADMIN_API_KEYS: Joi.string()
    .allow("")
    .pattern(/^([A-Za-z0-9_.-]+:(admin|superadmin):[^,:]{16,})(,[A-Za-z0-9_.-]+:(admin|superadmin):[^,:]{16,})*$/)
    .default(""),

  // ── Guardian emergency ingestion (issue #507) ─────────────────────────────
  GUARDIAN_CONTRACT_ID: Joi.string().allow("").default(""),

  // ── Synthetic canary (issue #496) ─────────────────────────────────────────
  // Comma-separated canary user/solver addresses, excluded from public stats
  // and leaderboards.
  CANARY_ADDRESSES: Joi.string().allow("").default(""),
});
