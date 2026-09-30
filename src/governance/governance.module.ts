import { Module, forwardRef } from "@nestjs/common";
import { ProtocolParamsService } from "./params.service";
import { ParamsController } from "./params.controller";
import { SorobanModule } from "../soroban/soroban.module";
import { GuardianController } from "./guardian.controller";
import { GuardianService } from "./guardian.service";

// GovernanceModule → SorobanModule → IntentsModule → GovernanceModule forms a
// cycle; the SorobanModule edge must be deferred so the import resolves after
// SorobanModule has finished loading.

/**
 * Governance module — exposes protocol parameters sourced from the on-chain
 * governance / parameters contract, and ingests guardian emergency actions
 * (issue #507).
 *
 * Exports `ProtocolParamsService` so other modules (e.g. `IntentsModule`) can
 * inject it to snapshot parameters at intent-creation time.
 */
@Module({
  imports: [forwardRef(() => SorobanModule)],
  controllers: [ParamsController, GuardianController],
  providers: [ProtocolParamsService, GuardianService],
  exports: [ProtocolParamsService, GuardianService],
})
export class GovernanceModule {}
