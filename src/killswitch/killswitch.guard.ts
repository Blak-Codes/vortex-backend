import { CanActivate, Injectable } from "@nestjs/common";
import { KillSwitchService } from "./killswitch.service";

/** Rejects the route with 503 while the protocol is paused (operator or guardian). */
@Injectable()
export class KillSwitchGuard implements CanActivate {
  constructor(private readonly killSwitch: KillSwitchService) {}

  canActivate(): boolean {
    this.killSwitch.assertOperational();
    return true;
  }
}
