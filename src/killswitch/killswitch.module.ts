import { Global, Module } from "@nestjs/common";
import { KillSwitchController } from "./killswitch.controller";
import { KillSwitchGuard } from "./killswitch.guard";
import { KillSwitchService } from "./killswitch.service";

@Global()
@Module({
  controllers: [KillSwitchController],
  providers: [KillSwitchService, KillSwitchGuard],
  exports: [KillSwitchService, KillSwitchGuard],
})
export class KillSwitchModule {}
