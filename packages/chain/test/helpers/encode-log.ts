// Encode a vault event the way the EVM would (topics + ABI-encoded data) from the compiled ABI. viem 2.56.9 has no
// encodeEventLog export, so this composes encodeEventTopics + encodeAbiParameters. Used to check that the decoders
// invert real node output, and to build logs for tests that do not need a node.
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem";
import { symbolonVaultAbi } from "../../src/abi/symbolonVault";

export function encodeVaultLog(eventName: string, args: Readonly<Record<string, unknown>>): { topics: Hex[]; data: Hex } {
  const item = symbolonVaultAbi.find((x): x is Extract<(typeof symbolonVaultAbi)[number], { type: "event" }> => x.type === "event" && x.name === eventName);
  if (item === undefined) throw new Error(`no event ${eventName} in the vault ABI`);
  const event = item as unknown as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: args as never }) as Hex[];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = plain.length === 0 ? "0x" : encodeAbiParameters(plain, plain.map((i) => args[i.name as string]));
  return { topics, data };
}
