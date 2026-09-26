import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { SUPPORTED_TOKENS, STELLAR_TOKENS } from "./tokens.data";
import { SupportedChain } from "../intents/intents.types";
import { ITokensRepository, TOKENS_REPOSITORY, TokenRecord } from "./tokens.repository";

/**
 * A resolved source-chain (EVM or Stellar source) token — always has a
 * canonical `address` field used by TokensService.resolveToken().
 */
export interface ResolvedSrcToken {
  kind: "src";
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  priceUSD: number | null;
}

/**
 * A resolved Stellar destination token.
 */
export interface ResolvedDstToken {
  kind: "dst";
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number | null;
}

export type ResolvedToken = ResolvedSrcToken | ResolvedDstToken;

/** Shape returned by getStellarTokens — priceUSD is nullable (issue #332). */
export interface ResolvedStellarToken {
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number | null;
}

@Injectable()
export class TokensService {
  constructor(
    @Inject(TOKENS_REPOSITORY)
    private readonly repo: ITokensRepository,
  ) {}

  /**
   * Look up a source token by chain + address/contract.
   *
   * For Stellar source tokens the `address` parameter is the contract ID.
   * For EVM chains it is the checksummed hex address.
   *
   * Returns `undefined` when no match is found — callers decide how to handle
   * the "unknown token" case (e.g. fall back to a default priceUSD).
   *
   * @param chain   The source chain (stellar | ethereum | base | …)
   * @param address Token contract/address string
   */
  resolveSrcToken(chain: SupportedChain, address: string): ResolvedSrcToken | undefined {
    // ITokensRepository.findByAddressAndChain may be sync or async; the in-memory
    // implementation is always synchronous so we cast to the sync result type.
    const token = this.repo.findByAddressAndChain(address, chain) as TokenRecord | undefined;
    if (!token) return undefined;
    return {
      kind: "src",
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      chain,
      priceUSD: token.priceUsd ?? null,
    };
  }

  /**
   * Look up a Stellar destination token by contract ID.
   *
   * Returns `undefined` when no match is found.
   */
  resolveDstToken(contract: string): ResolvedDstToken | undefined {
    const token = this.repo.findByAddressAndChain(contract, "stellar") as TokenRecord | undefined;
    if (!token) return undefined;
    return {
      kind: "dst",
      contract: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      priceUSD: token.priceUsd ?? null,
    };
  }

  /**
   * Like {@link resolveSrcToken} but throws a `BadRequestException` instead of
   * returning `undefined` when the chain + address does not resolve to a token
   * in the configured registry (issue #276).
   *
   * Use this on the write path (intent creation) where an unrecognised token
   * must be rejected outright rather than silently stored with no priceUSD.
   */
  resolveSrcTokenOrThrow(chain: SupportedChain, address: string): ResolvedSrcToken {
    const token = this.resolveSrcToken(chain, address);
    if (!token) {
      throw new BadRequestException(
        `Unknown source token '${address}' for chain '${chain}' in the configured token registry`,
      );
    }
    return token;
  }

  /**
   * Like {@link resolveDstToken} but throws a `BadRequestException` instead of
   * returning `undefined` when the contract does not resolve to a known Stellar
   * token (issue #276).
   */
  resolveDstTokenOrThrow(contract: string): ResolvedDstToken {
    const token = this.resolveDstToken(contract);
    if (!token) {
      throw new BadRequestException(
        "Unknown destination token contract for the configured token registry",
      );
    }
    return token;
  }

  getByChain(chain?: string) {
    const stellarTokens = STELLAR_TOKENS.map((t) => ({
      contract: t.contract,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      priceUSD: t.priceUSD ?? null,
    }));

    const chainRecords = Object.entries(SUPPORTED_TOKENS).flatMap(([chainKey, tokens]) =>
      tokens.map((t) => ({
        address: t.address,
        contract: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        chain: chainKey,
        priceUSD: t.priceUSD ?? null,
      })),
    );

    if (chain === "stellar") {
      return { tokens: stellarTokens, chain: "stellar" };
    }
    if (chain && chain in SUPPORTED_TOKENS) {
      return {
        tokens: chainRecords.filter((t) => t.chain === chain),
        chain,
      };
    }
    return {
      tokens: Object.fromEntries(
        Object.keys(SUPPORTED_TOKENS).map((key) => [
          key,
          chainRecords.filter((t) => t.chain === key),
        ]),
      ),
      stellarTokens,
    };
  }

  async getStellarTokens(): Promise<{ tokens: ResolvedStellarToken[] }> {
    const tokens = await this.repo.findByChain("stellar");
    return {
      tokens: tokens.map((t) => ({
        contract: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        priceUSD: t.priceUsd ?? null,
      })),
    };
  }
}
