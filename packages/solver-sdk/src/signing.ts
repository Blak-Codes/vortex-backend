import { Keypair } from "@stellar/stellar-sdk";

/**
 * Canonical messages — byte-for-byte identical to the server's builders in
 * src/common/stellar-signature.ts. The shared vectors in
 * test-vectors/signatures.json are checked on both sides.
 */
export const messages = {
  accept: (intentId: string, solver: string) => `accept:${intentId}:${solver}`,
  fill: (intentId: string, solver: string) => `fill:${intentId}:${solver}`,
  cancel: (intentId: string) => `cancel:${intentId}`,
  wsAuth: (solver: string, timestamp: number | string) => `solver-auth:${solver}:${String(timestamp)}`,
  register: (address: string) => `register:${address}`,
};

/** Ed25519 signature over the UTF-8 message, base64-encoded (the server's format). */
export function signMessage(keypair: Keypair, message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

/** Body for POST /api/v1/intents/{id}/accept. */
export function signAccept(keypair: Keypair, intentId: string) {
  const solver = keypair.publicKey();
  return { solver, signature: signMessage(keypair, messages.accept(intentId, solver)) };
}

/** Body for POST /api/v1/intents/{id}/fill. */
export function signFill(keypair: Keypair, intentId: string, fillAmount: string, txHash?: string) {
  const solver = keypair.publicKey();
  return {
    solver,
    fillAmount,
    ...(txHash ? { txHash } : {}),
    signature: signMessage(keypair, messages.fill(intentId, solver)),
  };
}

/** Body for POST /api/v1/intents/{id}/cancel (signed by the intent's user). */
export function signCancel(keypair: Keypair, intentId: string) {
  return { user: keypair.publicKey(), signature: signMessage(keypair, messages.cancel(intentId)) };
}

/** WS `{ type: "auth" }` frame. */
export function signWsAuth(keypair: Keypair, timestamp = Math.floor(Date.now() / 1000)) {
  const solver = keypair.publicKey();
  return { type: "auth" as const, solver, timestamp, signature: signMessage(keypair, messages.wsAuth(solver, timestamp)) };
}
