import { Module } from "@nestjs/common";
import { ProtocolParamsService } from "./params.service";
import { ParamsController } from "./params.controller";

/**
 * Governance module — exposes protocol parameters sourced from the on-chain
 * governance / parameters contract.
 *
 * Exports `ProtocolParamsService` so other modules (e.g. `IntentsModule`) can
 * inject it to snapshot parameters at intent-creation time.
 */
@Module({
  controllers: [ParamsController],
  providers: [ProtocolParamsService],
  exports: [ProtocolParamsService],
})
export class GovernanceModule {}
