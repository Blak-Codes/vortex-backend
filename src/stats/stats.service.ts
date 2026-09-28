import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { AppConfig } from "../config/configuration";
import { isCanaryIntent } from "../common/canary";
import { IntentsService } from "../intents/intents.service";
import { SUPPORTED_CHAINS } from "../intents/intents.types";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "../intents/intents.gateway";

@Injectable()
export class StatsService {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
    @Optional() config?: ConfigService<AppConfig, true>,
  ) {
    this.canary = new Set(config?.get("canaryAddresses", { infer: true }) ?? []);
  }

  /** Canary addresses (issue #496) — their intents and solvers never count toward public stats. */
  private readonly canary: ReadonlySet<string>;

  private async publicIntents() {
    return (await this.intentsService.getAll()).filter((i) => !isCanaryIntent(i, this.canary));
  }

  private canonicalJson(value: unknown): string {
    const seen = new WeakSet();

    const normalize = (input: unknown): unknown => {
      if (Array.isArray(input)) {
        return input.map((item) => normalize(item));
      }
      if (input && typeof input === "object") {
        if (seen.has(input)) {
          return "[Circular]";
        }
        seen.add(input);
        return Object.keys(input as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = normalize((input as Record<string, unknown>)[key]);
            return acc;
          }, {});
      }
      return input;
    };

    return JSON.stringify(normalize(value));
  }

  private getPublicDatasetUrl() {
    return process.env.PUBLIC_STATS_DATASET_URL ?? "https://example.invalid/public-stats/latest.json";
  }

  private getPublicSigningKey() {
    return process.env.PUBLIC_STATS_SIGNING_KEY ?? "public-stats-dev-key";
  }

  private getProvenance(payload: Record<string, unknown>) {
    const safePayload = { ...payload };
    delete safePayload.provenance;
    const generatedAt = new Date().toISOString();
    const signature = createHmac("sha256", this.getPublicSigningKey())
      .update(this.canonicalJson({ ...safePayload, generatedAt }))
      .digest("hex");

    return {
      watermarkLedger: 0,
      generatedAt,
      queryVersion: "public-stats/v1",
      datasetUrl: this.getPublicDatasetUrl(),
      signature,
    };
  }

  async getProtocolStats() {
    const intents = await this.publicIntents();
    const solvers = (await this.solversService.getAll()).filter((s) => !this.canary.has(s.address));

    const open = intents.filter((i) => i.state === "open").length;
    const filled = intents.filter((i) => i.state === "filled");
    const totalVolume = filled.reduce((sum, i) => sum + BigInt(i.fillAmount ?? "0"), 0n);

    const fillTimes = filled
      .filter((i) => i.filledAt != null)
      .map((i) => i.filledAt! - i.createdAt);
    const avgFillTime = fillTimes.length
      ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
      : 0;

    return {
      totalIntents: intents.length,
      openIntents: open,
      totalVolume: totalVolume.toString(),
      uniqueUsers: new Set(intents.map((i) => i.user)).size,
      activeSolvers: solvers.filter((s) => s.isActive).length,
      avgFillTime: Math.round(avgFillTime),
      fillRate: intents.length ? filled.length / intents.length : 0,
    };
  }

  async getPublicStats() {
    const stats = await this.getProtocolStats();
    return {
      ...stats,
      provenance: this.getProvenance(stats),
    };
  }

  getPublicStatsHistory() {
    return [] as Array<Record<string, unknown>>;
  }

  async getTreasuryStats() {
    const intents = await this.publicIntents();
    const now = Math.floor(Date.now() / 1000);
    const last24hCutoff = now - 86_400;

    const allTime = intents
      .filter((intent) => typeof intent.feeAmount === "string" && intent.feeAmount.length > 0)
      .reduce((sum, intent) => sum + BigInt(intent.feeAmount ?? "0"), 0n);

    const last24h = intents
      .filter(
        (intent) =>
          typeof intent.feeAmount === "string" &&
          intent.feeAmount.length > 0 &&
          typeof intent.filledAt === "number" &&
          intent.filledAt >= last24hCutoff,
      )
      .reduce((sum, intent) => sum + BigInt(intent.feeAmount ?? "0"), 0n);

    const byChain = new Map<string, { totalFees: bigint; last24hFees: bigint; filledCount: number }>();

    for (const intent of intents) {
      if (typeof intent.feeAmount !== "string" || intent.feeAmount.length === 0) continue;
      const fee = BigInt(intent.feeAmount ?? "0");
      const entry = byChain.get(intent.srcChain) ?? {
        totalFees: 0n,
        last24hFees: 0n,
        filledCount: 0,
      };

      entry.totalFees += fee;
      entry.filledCount += 1;
      if (typeof intent.filledAt === "number" && intent.filledAt >= last24hCutoff) {
        entry.last24hFees += fee;
      }
      byChain.set(intent.srcChain, entry);
    }

    return {
      allTime: {
        totalFees: allTime.toString(),
        filledIntents: intents.filter((intent) => typeof intent.feeAmount === "string" && intent.feeAmount.length > 0).length,
      },
      last24h: {
        totalFees: last24h.toString(),
        filledIntents: intents.filter(
          (intent) =>
            typeof intent.feeAmount === "string" &&
            intent.feeAmount.length > 0 &&
            typeof intent.filledAt === "number" &&
            intent.filledAt >= last24hCutoff,
        ).length,
      },
      byChain: Array.from(byChain.entries()).map(([srcChain, stats]) => ({
        srcChain,
        totalFees: stats.totalFees.toString(),
        last24hFees: stats.last24hFees.toString(),
        filledIntents: stats.filledCount,
      })),
    };
  }

  getWsStats() {
    return {
      subscriberCount: this.intentsGateway.getSubscriberCount(),
    };
  }
}
