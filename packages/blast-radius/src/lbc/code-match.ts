// Code match (docs/16 §5.3): the empirical claim ("0 violations in N trials") transfers only to the exact bytecode that
// was tested. `matchArtifact` zeroes the byte ranges listed in `deployedBytecode.immutableReferences` in BOTH the
// on-chain code and the Foundry artifact (immutables differ per deployment: token, caps, delays), then compares.
// The hash of the zeroed artifact code is the `vaultRuntimeCodeHash` that validation results carry (provenance.ts).
// Pure: the caller fetches the code and reads the artifact file.
import { keccak256 } from "viem";
import * as z from "zod";
import { LbcError } from "./types";
import type { Hex } from "./types";

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

const ArtifactSchema = z.object({
  deployedBytecode: z.object({
    object: z.string().regex(HEX_BYTES),
    immutableReferences: z.record(z.string(), z.array(z.object({ start: z.number().int().min(0), length: z.number().int().min(1) }))).default({}),
  }),
});

export interface ParsedArtifact {
  /** artifact runtime code, immutables zeroed */
  readonly zeroedCode: Hex;
  readonly ranges: readonly { readonly start: number; readonly length: number }[];
  readonly codeHash: Hex;
}

function zero(codeHex: string, ranges: readonly { start: number; length: number }[]): Hex {
  const bytes = Buffer.from(codeHex.slice(2), "hex");
  for (const r of ranges) {
    if (r.start + r.length > bytes.length) throw new LbcError("ARTIFACT_INVALID", "an immutable reference lies outside the runtime code");
    bytes.fill(0, r.start, r.start + r.length);
  }
  return `0x${bytes.toString("hex")}`;
}

/** Parse a Foundry JSON artifact (the whole file, already JSON.parsed). Throws LbcError("ARTIFACT_INVALID"). */
export function parseArtifact(json: unknown): ParsedArtifact {
  const r = ArtifactSchema.safeParse(json);
  if (!r.success) throw new LbcError("ARTIFACT_INVALID", "not a Foundry artifact with deployedBytecode.object");
  const ranges = Object.values(r.data.deployedBytecode.immutableReferences).flat();
  if (r.data.deployedBytecode.object === "0x") throw new LbcError("ARTIFACT_INVALID", "the artifact has empty runtime code");
  const zeroedCode = zero(r.data.deployedBytecode.object, ranges);
  return { zeroedCode, ranges, codeHash: keccak256(zeroedCode) };
}

export type CodeMatchResult =
  | { readonly status: "MATCH"; readonly codeHash: Hex }
  | { readonly status: "MISMATCH"; readonly codeHash: Hex; readonly onchainCodeHash: Hex | null }
  | { readonly status: "NOT_CHECKED"; readonly codeHash: null };

/** Compare on-chain runtime code to a parsed artifact. Empty on-chain code is a MISMATCH (never a match). */
export function matchArtifact(onchainCode: Hex, artifact: ParsedArtifact): CodeMatchResult {
  if (!HEX_BYTES.test(onchainCode) || onchainCode === "0x") return { status: "MISMATCH", codeHash: artifact.codeHash, onchainCodeHash: null };
  let zeroedOnchain: Hex;
  try {
    zeroedOnchain = zero(onchainCode, artifact.ranges);
  } catch {
    return { status: "MISMATCH", codeHash: artifact.codeHash, onchainCodeHash: null };
  }
  if (zeroedOnchain.toLowerCase() === artifact.zeroedCode.toLowerCase()) return { status: "MATCH", codeHash: artifact.codeHash };
  return { status: "MISMATCH", codeHash: artifact.codeHash, onchainCodeHash: keccak256(zeroedOnchain) };
}
