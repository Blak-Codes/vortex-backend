import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags } from "@nestjs/swagger";
import { AppConfig } from "../config/configuration";
import { DatabaseHealthService } from "./database-health.service";
import { KillSwitchService } from "../killswitch/killswitch.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly dbHealth: DatabaseHealthService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  @Get("live")
  live() {
    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
    };
  }

  @Get("ready")
  async ready() {
    const db = await this.dbHealth.check();

    return {
      status: db.status === "ok" ? "ok" : "unreachable",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
      db,
    };
  }

  @Get()
  async check() {
    const db = await this.dbHealth.check();
    const killswitch = this.killSwitch.status();

    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
      db,
      // Issue #477 — an active pause is an operational state, not an outage:
      // liveness stays "ok" so a pause never triggers a restart loop. Callers
      // that need to distinguish "healthy but paused" read `killswitch`.
      killswitch: {
        ready: killswitch.ready,
        propagation: killswitch.propagation,
        activePauses: killswitch.switches
          .filter((entry) => entry.active)
          .map((entry) => ({
            scope: entry.scope,
            chain: entry.chain,
            token: entry.token,
            operation: entry.operation,
            reasonCode: entry.reasonCode,
            since: entry.updatedAt,
          })),
      },
    };
  }
}
