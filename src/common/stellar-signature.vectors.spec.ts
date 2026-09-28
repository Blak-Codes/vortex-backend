import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildAcceptMessage,
  buildCancelMessage,
  buildFillMessage,
  buildRegisterMessage,
  buildWsAuthMessage,
  verifyStellarSignature,
} from "./stellar-signature";

/**
 * Server side of the shared signing vectors (issue #446): the solver SDK must
 * produce exactly these messages and signatures, and the server must accept
 * them. The SDK checks the same file in test/solver-sdk.e2e-spec.ts.
 */
// Read at runtime: the vectors live in the SDK package, outside tsconfig rootDir.
const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../packages/solver-sdk/test-vectors/signatures.json"), "utf8"),
) as {
  seedByte: number;
  publicKey: string;
  intentId: string;
  timestamp: number;
  vectors: Array<{ kind: string; message: string; signature: string }>;
};

describe("shared signature test vectors", () => {
  const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, vectors.seedByte));
  const { intentId, publicKey, timestamp } = vectors;
  const serverMessages: Record<string, string> = {
    accept: buildAcceptMessage(intentId, publicKey),
    fill: buildFillMessage(intentId, publicKey),
    cancel: buildCancelMessage(intentId),
    wsAuth: buildWsAuthMessage(publicKey, timestamp),
    register: buildRegisterMessage(publicKey),
  };

  it("derives the vector key", () => {
    expect(kp.publicKey()).toBe(publicKey);
  });

  it.each(vectors.vectors)("$kind: server builds the same message and accepts the signature", ({ kind, message, signature }) => {
    expect(serverMessages[kind]).toBe(message);
    expect(() => verifyStellarSignature(publicKey, message, signature)).not.toThrow();
  });
});
