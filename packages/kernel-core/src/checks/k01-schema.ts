// K-01 STRICT_SCHEMA — onFail REJECT — P0 (docs/04 K-01, INV-23).
// Strict Zod parse of PaymentIntent (unknown keys fail), then the intent must reference this tenant's
// kernel-stored document, contain no binary-looking payload in any string field, and stay within the size
// limit; the kernel-stored document text must be bounded text (limits.maxDocChars; sandbox <= 4,096 UTF-8
// bytes) with no binary-looking content. Any of these => REJECT SCHEMA_INVALID, and nothing downstream runs.
// A stored-text hash mismatch is a kernel/service fault, not a bad intent: HOLD KERNEL_ERROR (no short-circuit).
import { PaymentIntentSchema, inspectUntrusted, jcs, keccak256Utf8 } from "@symbolon/schemas";
import type { PaymentIntent } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "../context";
import { binaryKind, utf8ByteLength } from "../text";
import { fail, kernelError, pass } from "../verdict";
import type { CheckResult } from "@symbolon/schemas";

/** docs/04 K-01 v2: the sandbox document limit, in UTF-8 bytes. */
export const SANDBOX_MAX_DOC_BYTES = 4096;

/**
 * Size limit for the whole intent (JCS characters): two extractions of a document of at most
 * `limits.maxDocChars` characters plus fixed overhead. 20,000 => 96,384; sandbox 4,096 => 32,768.
 */
export function maxIntentChars(maxDocChars: number): number {
  return 4 * maxDocChars + 16_384;
}

export interface K01Outcome {
  readonly result: CheckResult;
  /** The parsed intent, or null when K-01 rejected it (the pipeline short-circuits). */
  readonly intent: PaymentIntent | null;
}

const reject = (detail: string): K01Outcome => ({ result: fail("K-01", "REJECT", "SCHEMA_INVALID", detail), intent: null });

/** Every string value in a parsed intent, with its path (keys are fixed by the strict schema). */
function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
  }
}

export function checkK01(raw: unknown, ctx: KernelContext, policy: LoadedPolicy): K01Outcome {
  const parsed = PaymentIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const where = issues
      .slice(0, 5)
      .map((i) => `${i.code}@${i.path.length === 0 ? "$" : i.path.map(String).join(".")}`)
      .join(", ");
    return reject(`strict schema rejected the intent (${issues.length} issue(s)): ${where}`);
  }
  const intent = parsed.data;
  if (intent.tenantId !== ctx.tenantId) return reject("intent.tenantId does not match the kernel context tenant");
  if (intent.docHash !== ctx.doc.hash) return reject("intent.docHash does not match the kernel-stored document");

  for (const [path, s] of strings(intent, "intent")) {
    const kind = binaryKind(s);
    if (kind !== null) return reject(`binary-looking payload (${kind}) at ${path} (INV-23)`);
  }
  const maxDocChars = policy.policy.limits.maxDocChars;
  const size = jcs(intent).length;
  if (size > maxIntentChars(maxDocChars)) return reject(`intent is oversize: ${size} > ${maxIntentChars(maxDocChars)} JCS characters`);

  const text = inspectUntrusted(ctx.doc.normalizedText);
  if (typeof text !== "string") return reject("kernel-stored document text is not text");
  if (text.length > maxDocChars) return reject(`document text is oversize: ${text.length} > limits.maxDocChars ${maxDocChars}`);
  if (ctx.profile === "sandbox" && utf8ByteLength(text) > SANDBOX_MAX_DOC_BYTES) {
    return reject(`document text is oversize for the sandbox: more than ${SANDBOX_MAX_DOC_BYTES} UTF-8 bytes`);
  }
  const docKind = binaryKind(text);
  if (docKind !== null) return reject(`binary-looking content (${docKind}) in the document text (INV-23)`);

  if (keccak256Utf8(text) !== ctx.doc.normalizedHash) {
    return { result: kernelError("K-01", "doc.normalizedHash does not match keccak256(UTF-8(normalizedText))"), intent };
  }
  return { result: pass("K-01", "strict schema, document binding, no binary payload, size limits"), intent };
}
