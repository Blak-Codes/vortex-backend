import { Body, Controller, HttpCode, Logger, Post, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { KillSwitchService } from "./killswitch.service";

export class KillSwitchReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Operator kill switch. Operator state never clears guardian state: resuming
 * here leaves the protocol paused while a guardian pause is active.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller("admin/killswitch")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class KillSwitchController {
  private readonly logger = new Logger(KillSwitchController.name);

  constructor(
    private readonly killSwitch: KillSwitchService,
    private readonly audit: AdminAuditService,
  ) {}

  @Post("pause")
  @HttpCode(200)
  @ApiOperation({ summary: "Operator pause (applies even if the audit write fails)" })
  async pause(@Body() dto: KillSwitchReasonDto, @CurrentAdmin() admin: AdminPrincipal) {
    // Safety-increasing: apply first, then audit best-effort.
    this.killSwitch.setPause("operator", true, { since: new Date().toISOString(), reason: dto.reason });
    await this.audit
      .record({ actor: admin.id, action: "killswitch.pause", target: "killswitch", reason: dto.reason })
      .catch(() => this.logger.error("[killswitch] operator pause applied WITHOUT audit record"));
    return this.killSwitch.snapshot();
  }

  @Post("resume")
  @HttpCode(200)
  @ApiOperation({ summary: "Clear the operator pause; guardian pauses stay in effect" })
  async resume(@Body() dto: KillSwitchReasonDto, @CurrentAdmin() admin: AdminPrincipal) {
    await this.audit.record({ actor: admin.id, action: "killswitch.resume", target: "killswitch", reason: dto.reason });
    this.killSwitch.setPause("operator", false, { since: new Date().toISOString(), reason: dto.reason });
    return this.killSwitch.snapshot();
  }
}
