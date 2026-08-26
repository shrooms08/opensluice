/**
 * Ledger transfer construction, written against docs/tachi-smoke-output.md:
 *  - a plain key→key TRANSFER needs no vault and no PSBT (empty psbtPayload);
 *  - inputs reference a VTXO by id with an all-zero txid (ledger-minted);
 *  - a VTXO's id is computeVtxoId(txHash, vout) — asserted MATCH against the
 *    live daemon for both a deposit and two transfers in the smoke run, so a
 *    payment id stays stable from the moment it is broadcast.
 */
import {
  computeVtxoId,
  encodeTachiTx,
  signTachiTx,
  TACHI_TX_TYPE_TRANSFER,
  TACHI_TX_VERSION,
  type TachiTx,
  type TaprootSigner,
} from "@tachibtc/taurus-vault-core";

export interface TransferInput {
  vtxoId: string; // hex
  valueSats: bigint;
}

export interface TransferOutput {
  owner: Buffer; // 32-byte x-only
  amountSats: bigint;
}

export interface BuildTransferArgs {
  signer: TaprootSigner;
  /** x-only key of the spender; every input must be owned by it. */
  spenderXOnly: Buffer;
  inputs: TransferInput[];
  outputs: TransferOutput[];
  feeSats: bigint;
  nonce: bigint;
}

/** Build, sign (BIP-340 over the TachiTx sighash) and wire-encode a transfer. Returns hex (no 0x). */
export async function buildSignedTransferHex(args: BuildTransferArgs): Promise<string> {
  const inSum = args.inputs.reduce((a, i) => a + i.valueSats, 0n);
  const outSum = args.outputs.reduce((a, o) => a + o.amountSats, 0n);
  if (inSum !== outSum + args.feeSats) {
    throw new Error(`transfer does not balance: inputs ${inSum} != outputs ${outSum} + fee ${args.feeSats}`);
  }
  const tx: TachiTx = {
    version: TACHI_TX_VERSION,
    type: TACHI_TX_TYPE_TRANSFER,
    inputs: args.inputs.map((i) => ({
      vtxoId: Buffer.from(i.vtxoId, "hex"),
      txid: Buffer.alloc(32, 0),
      vout: 0,
      valueSats: i.valueSats,
      sigScript: Buffer.alloc(0),
    })),
    outputs: args.outputs.map((o) => ({ owner: o.owner, amount: o.amountSats, script: Buffer.alloc(0) })),
    fee: args.feeSats,
    nonce: args.nonce,
    pubKey: args.spenderXOnly,
    signature: Buffer.alloc(0),
    psbtPayload: Buffer.alloc(0),
    vaultPayload: Buffer.alloc(0),
  };
  const signed = await signTachiTx(tx, args.signer);
  return encodeTachiTx(signed).toString("hex");
}

/** Deterministic VTXO id for output `vout` of tx `txHash` (hex, either case). */
export function vtxoIdFor(txHash: string, vout: number): string {
  return computeVtxoId(txHash.toLowerCase(), vout).toString("hex");
}
