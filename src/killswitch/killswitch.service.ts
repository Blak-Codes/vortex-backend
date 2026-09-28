import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

/** Who asserted a state. Guardian state is authoritative while active. */
export type KillSwitchSource = "operator" | "guardian";

/** Reference to the input that set a state (on-chain tx or operator action). */
export interface StateRef {
  since: string;
  reason: string;
  /** Guardian action id (Soroban event id). */
  actionId?: string;
  txHash?: string;
}

export interface KillSwitchSnapshot {
  paused: boolean;
  pause: Partial<Record<KillSwitchSource, StateRef>>;
  suspendedSolvers: Record<string, StateRef>;
  frozenParams: Record<string, StateRef>;
}

/** Target that freezes every runtime parameter. */
export const ALL_PARAMS = "*";

/**
 * Protocol kill switch and derived policy state (issue #507).
 *
 * Each state is kept per source and the effective value is their OR: an
 * operator resume does not clear a guardian pause and a guardian unpause does
 * not clear an operator pause — both must clear. Only guardian events (or a
 * superadmin override in GovernanceModule) change guardian-sourced state.
 */
@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);
  private readonly pause = new Map<KillSwitchSource, StateRef>();
  private readonly suspendedSolvers = new Map<string, StateRef>();
  private readonly frozenParams = new Map<string, StateRef>();

  isPaused(): boolean {
    return this.pause.size > 0;
  }

  /** Throws 503 while any source holds the protocol paused. */
  assertOperational(): void {
    if (!this.isPaused()) return;
    const sources = [...this.pause.keys()].join(" + ");
    throw new ServiceUnavailableException(`Protocol is paused (${sources}); new operations are rejected`);
  }

  setPause(source: KillSwitchSource, active: boolean, ref: StateRef): void {
    if (active) this.pause.set(source, ref);
    else this.pause.delete(source);
    this.logger.warn(
      `[killswitch] ${source} pause ${active ? "ON" : "OFF"} (${ref.reason}) — effective paused=${this.isPaused()}`,
    );
  }

  isSolverSuspended(address: string): boolean {
    return this.suspendedSolvers.has(address);
  }

  setSolverSuspended(address: string, active: boolean, ref: StateRef): void {
    if (active) this.suspendedSolvers.set(address, ref);
    else this.suspendedSolvers.delete(address);
    this.logger.warn(`[killswitch] solver ${address} suspension ${active ? "ON" : "OFF"} (${ref.reason})`);
  }

  isParamFrozen(key: string): boolean {
    return this.frozenParams.has(key) || this.frozenParams.has(ALL_PARAMS);
  }

  setParamFrozen(key: string, active: boolean, ref: StateRef): void {
    if (active) this.frozenParams.set(key, ref);
    else this.frozenParams.delete(key);
    this.logger.warn(`[killswitch] parameter ${key} freeze ${active ? "ON" : "OFF"} (${ref.reason})`);
  }

  snapshot(): KillSwitchSnapshot {
    return {
      paused: this.isPaused(),
      pause: Object.fromEntries(this.pause),
      suspendedSolvers: Object.fromEntries(this.suspendedSolvers),
      frozenParams: Object.fromEntries(this.frozenParams),
    };
  }
}
