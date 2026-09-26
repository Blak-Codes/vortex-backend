/**
 * Single source of truth for every chain the protocol recognises.
 * `SupportedChain` is derived from this tuple so all three consumers
 * (intents.types.ts, create-intent.dto.ts, tokens.data.ts) stay in sync
 * automatically — see issue #128.
 */
export const SUPPORTED_CHAINS = [
  "stellar",
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/**
 * A single entry in the append-only audit log for an intent.
 * Every state transition — cancel, expire, accept, fill — appends one entry.
 * Once persistence lands (issue #36) this will be written to an `intent_audit_log`
 * table; for now it lives in-memory alongside the intent map.
 */
export interface IntentAuditEntry {
  /** ISO-8601 UTC timestamp of the transition. */
  timestamp: string;
  /** State the intent moved INTO. */
  toState: IntentState;
  /** Actor who triggered the transition: a user address, solver address, or "system". */
  actor: string;
  /** Human-readable explanation, e.g. "user cancelled", "deadline passed". */
  reason: string;
  /** Optional extra data (fill amount, tx hash, …). */
  metadata?: Record<string, unknown>;
}

/**
 * Single source of truth for every state an intent can be in.
 * `IntentState` is derived from this tuple so DTO validators (`@IsIn`),
 * Swagger `enum:` annotations, and type-checking all stay in sync
 * automatically — mirrors how `SUPPORTED_CHAINS` is defined above (issue #270).
 *
 * Issue #385 — pending_ states represent submitted-but-unconfirmed on-chain
 * writes.  Each active state gains a corresponding pending twin:
 *   open          ← confirmed creation on-chain
 *   pending_open  ← create_intent tx submitted, awaiting ledger confirmation
 *   accepted      ← confirmed accept on-chain
 *   pending_accepted ← accept tx submitted, awaiting confirmation
 *   filled        ← confirmed fill on-chain
 *   pending_filled   ← fill tx submitted, awaiting confirmation
 *   cancelled     ← confirmed cancel on-chain
 *   pending_cancelled ← cancel tx submitted, awaiting confirmation
 *
 * The pending states are NOT terminal and are excluded from eviction sweeps.
 * They are only used when ONCHAIN_INTENTS_ENABLED=true; the in-memory (off-chain)
 * path continues to use the base states directly.
 */
export const INTENT_STATES = [
  "open",
  "pending_open",      // submitted create_intent tx, awaiting ledger confirmation
  "accepted",
  "pending_accepted",  // submitted accept tx, awaiting ledger confirmation
  "filled",
  "pending_filled",    // submitted fill tx, awaiting ledger confirmation
  "cancelled",
  "pending_cancelled", // submitted cancel tx, awaiting ledger confirmation
  "expired",
  "slashed",
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoURI?: string;
  priceUSD?: number | null;
}

export interface StellarToken {
  contract: string;
  symbol: string;
  decimals: number;
  priceUSD?: number | null;
}

export interface Intent {
  intentId: string;
  user: string;
  srcChain: SupportedChain;
  srcToken: TokenInfo;
  srcAmount: string; // bigint as string
  dstToken: StellarToken;
  minDstAmount: string;
  quotedDstAmount?: string; // best quote from solvers
  solver?: string;
  state: IntentState;
  createdAt: number;
  deadline: number;
  filledAt?: number;
  fillAmount?: string;
  feeAmount?: string; // realized protocol fee in dst token base units
  txHash?: string; // fill tx on Stellar
  slashedAt?: number;
  slashReason?: string;
  /**
   * Transaction hash of the submitted-but-not-yet-confirmed on-chain write.
   * Only set when state is one of the `pending_*` variants (issue #385).
   * Cleared (set to undefined) once the intent transitions to the confirmed state.
   */
  pendingTxHash?: string;
  /**
   * Which write operation is pending, matching the current `pending_*` state.
   * Only set when state is one of the `pending_*` variants (issue #385).
   */
  pendingOp?: "create" | "accept" | "fill" | "cancel";
}

export interface Quote {
  intentId: string;
  solver: string;
  dstAmount: string;
  fee: string; // protocol fee in dst token
  fillTime: number; // estimated seconds
  expiresAt: number;
}

export interface RouteStep {
  type: "bridge" | "swap" | "transfer";
  protocol: string;
  fromChain: string;
  toChain: string;
  fromToken: TokenInfo;
  toToken: TokenInfo;
  estimatedTime: number;
  estimatedGas: string;
}

export interface Route {
  steps: RouteStep[];
  totalTime: number; // seconds
  totalFeesUSD: number;
  priceImpact: number;
}
