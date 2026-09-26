import { Module } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { SolversModule } from "../solvers/solvers.module";
import { SettlementContractClient } from "./settlement-contract.client";

@Module({
  imports: [SolversModule],
  controllers: [SorobanController],
  providers: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    SettlementContractClient,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    SettlementContractClient,
  ],
})
export class SorobanModule {}
