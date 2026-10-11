// Vault event and revert decoders (docs/05 section 6, docs/06 B.4). Fail closed:
//  - the log must come from the vault address we expect (any contract can emit a look-alike event);
//  - pending or removed logs are refused;
//  - viem decodes in strict mode, and the log must equal the canonical re-encoding of its decoded arguments
//    (exact topic count, exact data bytes, clean padding);
//  - an unknown selector from the vault is UNKNOWN_EVENT, never skipped silently.
// Amounts come back as Money at the decimals the caller verified on-chain (assertTokenDecimals).
// Event names follow the compiled contract: VaultPaused/VaultUnpaused (QUESTIONS WP-07 item 3).
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  isAddress,
  erc20Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { symbolonVaultAbi } from "./abi/symbolonVault";
import { ChainError } from "./errors";
import { money, type Money } from "./money";

/** The parts of a viem Log we rely on (structural, so receipts and getLogs results both fit). */
export interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: number | null;
  readonly removed?: boolean;
}

export interface LogMeta {
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface DecodeOptions {
  /** The vault that must have emitted the log. */
  readonly vault: Address;
  /** Settlement-token decimals, verified on-chain (assertTokenDecimals). */
  readonly decimals: number;
}

export type VaultEvent =
  | { readonly name: "ConfigChanged"; readonly configHash: Hex }
  | {
      readonly name: "EngagementRegistered";
      readonly engagementId: Hex;
      readonly owner: Address;
      readonly payee: Address;
      readonly cap: Money;
      readonly start: bigint;
      readonly end: bigint;
      readonly termsHash: Hex;
    }
  | { readonly name: "EngagementClosed"; readonly engagementId: Hex }
  | {
      readonly name: "Released";
      readonly intentId: Hex;
      readonly engagementId: Hex;
      readonly payee: Address;
      readonly amount: Money;
      readonly receiptHash: Hex;
    }
  | { readonly name: "PayeeChangeProposed"; readonly engagementId: Hex; readonly oldPayee: Address; readonly newPayee: Address; readonly eta: bigint }
  | { readonly name: "PayeeChangeExecuted"; readonly engagementId: Hex; readonly oldPayee: Address; readonly newPayee: Address }
  | { readonly name: "VaultPaused"; readonly by: Address }
  | { readonly name: "VaultUnpaused"; readonly by: Address }
  | { readonly name: "KernelSignerProposed"; readonly next: Address; readonly eta: bigint }
  | { readonly name: "KernelSignerRotated"; readonly previous: Address; readonly next: Address }
  | { readonly name: "GuardianChanged"; readonly previous: Address; readonly next: Address }
  | { readonly name: "Withdrawn"; readonly to: Address; readonly amount: Money }
  | { readonly name: "EIP712DomainChanged" };

export type VaultEventName = VaultEvent["name"];
export type DecodedVaultLog = { readonly event: VaultEvent; readonly meta: LogMeta };

function sameAddress(a: string, b: string): boolean {
  return isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && getAddress(a) === getAddress(b);
}

function metaOf(log: RawLog): LogMeta {
  if (log.removed === true) throw new ChainError("BAD_LOG", "log is marked removed (reorged)");
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new ChainError("BAD_LOG", "log is pending (no block number, transaction hash or log index)");
  }
  return { blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex };
}

const EVENT_ITEMS: ReadonlyMap<string, AbiEvent> = new Map(
  symbolonVaultAbi.flatMap((item) => (item.type === "event" ? [[item.name, item as unknown as AbiEvent] as const] : [])),
);

/**
 * The log must be exactly what the EVM would emit for the decoded arguments: same topics, same data bytes.
 * viem alone tolerates trailing data on all-indexed events and dirty padding bits in address words; re-encoding
 * and comparing closes both, so one decoded event has exactly one raw spelling.
 */
function assertCanonical(log: RawLog, eventName: string, args: unknown): void {
  const item = EVENT_ITEMS.get(eventName);
  if (item === undefined) throw new ChainError("UNKNOWN_EVENT", `event ${eventName} is not in the vault ABI`);
  const named = (args ?? {}) as Readonly<Record<string, unknown>>;
  let topics: readonly Hex[];
  let data: Hex;
  try {
    topics = encodeEventTopics({ abi: [item], eventName: item.name, args: named as never }) as Hex[];
    const plain = item.inputs.filter((i) => !i.indexed);
    data = plain.length === 0 ? "0x" : encodeAbiParameters(plain, plain.map((i) => named[i.name as string]));
  } catch (cause) {
    throw new ChainError("BAD_LOG", `${eventName}: cannot re-encode decoded arguments`, { cause });
  }
  const sameTopics = topics.length === log.topics.length && topics.every((t, i) => t.toLowerCase() === (log.topics[i] ?? "").toLowerCase());
  if (!sameTopics || data.toLowerCase() !== log.data.toLowerCase()) {
    throw new ChainError("BAD_LOG", `${eventName}: log is not the canonical encoding of its arguments (extra/missing topics or data, or dirty padding)`);
  }
}

/** Decode one log emitted by the vault. */
export function decodeVaultLog(log: RawLog, options: DecodeOptions): DecodedVaultLog {
  if (!sameAddress(log.address, options.vault)) {
    throw new ChainError("BAD_LOG", `log emitted by ${log.address}, expected vault ${options.vault}`);
  }
  const meta = metaOf(log);
  if (log.topics.length === 0) throw new ChainError("BAD_LOG", "log has no topics (anonymous events are not used)");

  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi: symbolonVaultAbi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data, strict: true }) as {
      eventName: string;
      args: unknown;
    };
  } catch (cause) {
    const selector = log.topics[0] ?? "";
    const isUnknown = cause instanceof BaseError && cause.name === "AbiEventSignatureNotFoundError";
    throw new ChainError(isUnknown ? "UNKNOWN_EVENT" : "BAD_LOG", isUnknown ? `unknown vault event selector ${selector}` : "log does not match its event ABI", { cause });
  }
  assertCanonical(log, decoded.eventName, decoded.args);
  return { event: toVaultEvent(decoded.eventName, decoded.args, options.decimals), meta };
}

/** Decode every log in `logs` that the vault emitted; logs from other contracts (the token's Transfer) are skipped by address, not by guess. */
export function decodeVaultLogs(logs: readonly RawLog[], options: DecodeOptions): DecodedVaultLog[] {
  return logs.filter((l) => sameAddress(l.address, options.vault)).map((l) => decodeVaultLog(l, options));
}

type Args = Readonly<Record<string, unknown>>;

function toVaultEvent(name: string, rawArgs: unknown, decimals: number): VaultEvent {
  const a: Args = (rawArgs ?? {}) as Args;
  const hex = (k: string): Hex => a[k] as Hex;
  const addr = (k: string): Address => a[k] as Address;
  const big = (k: string): bigint => a[k] as bigint;
  switch (name) {
    case "ConfigChanged":
      return { name, configHash: hex("configHash") };
    case "EngagementRegistered":
      return {
        name,
        engagementId: hex("engagementId"),
        owner: addr("owner"),
        payee: addr("payee"),
        cap: money(big("cap"), decimals),
        start: big("start"),
        end: big("end"),
        termsHash: hex("termsHash"),
      };
    case "EngagementClosed":
      return { name, engagementId: hex("engagementId") };
    case "Released":
      return {
        name,
        intentId: hex("intentId"),
        engagementId: hex("engagementId"),
        payee: addr("payee"),
        amount: money(big("amount"), decimals),
        receiptHash: hex("receiptHash"),
      };
    case "PayeeChangeProposed":
      return { name, engagementId: hex("engagementId"), oldPayee: addr("oldPayee"), newPayee: addr("newPayee"), eta: big("eta") };
    case "PayeeChangeExecuted":
      return { name, engagementId: hex("engagementId"), oldPayee: addr("oldPayee"), newPayee: addr("newPayee") };
    case "VaultPaused":
      return { name, by: addr("by") };
    case "VaultUnpaused":
      return { name, by: addr("by") };
    case "KernelSignerProposed":
      return { name, next: addr("next"), eta: big("eta") };
    case "KernelSignerRotated":
      return { name, previous: addr("previous"), next: addr("next") };
    case "GuardianChanged":
      return { name, previous: addr("previous"), next: addr("next") };
    case "Withdrawn":
      return { name, to: addr("to"), amount: money(big("amount"), decimals) };
    case "EIP712DomainChanged":
      return { name };
    default:
      throw new ChainError("UNKNOWN_EVENT", `vault event ${name} has no decoder (regenerate the ABI and extend decoders.ts)`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// ERC-20 Transfer (a deposit is a Transfer into the vault; docs/05 section 6)
// ---------------------------------------------------------------------------------------------------------

export interface Erc20Transfer {
  readonly from: Address;
  readonly to: Address;
  readonly amount: Money;
  readonly meta: LogMeta;
}

export function decodeErc20Transfer(log: RawLog, options: { readonly token: Address; readonly decimals: number }): Erc20Transfer {
  if (!sameAddress(log.address, options.token)) {
    throw new ChainError("BAD_LOG", `Transfer emitted by ${log.address}, expected token ${options.token}`);
  }
  const meta = metaOf(log);
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi: erc20Abi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data, strict: true }) as {
      eventName: string;
      args: unknown;
    };
  } catch (cause) {
    throw new ChainError("BAD_LOG", "log is not a well-formed ERC-20 event", { cause });
  }
  if (decoded.eventName !== "Transfer") throw new ChainError("UNKNOWN_EVENT", `expected Transfer, got ${decoded.eventName}`);
  if (log.topics.length !== 3) throw new ChainError("BAD_LOG", "ERC-20 Transfer must have exactly 3 topics (ERC-721 look-alike?)");
  const a = decoded.args as { from: Address; to: Address; value: bigint };
  return { from: a.from, to: a.to, amount: money(a.value, options.decimals), meta };
}

// ---------------------------------------------------------------------------------------------------------
// Reverts
// ---------------------------------------------------------------------------------------------------------

export interface VaultRevert {
  readonly errorName: string;
  readonly args: readonly unknown[] | undefined;
}

/** Decode raw revert data against the vault's custom errors (PerTxCap, DailyCap, ...). */
export function decodeVaultRevertData(data: Hex): VaultRevert {
  try {
    const r = decodeErrorResult({ abi: symbolonVaultAbi, data });
    return { errorName: r.errorName, args: r.args };
  } catch (cause) {
    throw new ChainError("BAD_REVERT_DATA", "revert data is not one of the vault's custom errors", { cause });
  }
}

/** Find the vault custom-error name inside a viem error chain, or undefined if there is none. */
export function vaultRevertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName;
  return undefined;
}
