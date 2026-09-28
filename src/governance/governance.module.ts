import { Module } from "@nestjs/common";
import { SorobanModule } from "../soroban/soroban.module";
import { GuardianController } from "./guardian.controller";
import { GuardianService } from "./guardian.service";

/** On-chain governance inputs — guardian emergency actions (issue #507). */
@Module({
  imports: [SorobanModule],
  controllers: [GuardianController],
  providers: [GuardianService],
  exports: [GuardianService],
})
export class GovernanceModule {}
