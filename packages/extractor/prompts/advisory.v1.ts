// Advisory (AI) note prompt, version 1 (docs/03 §6, INV-20). The model sees ONLY kernel-derived structured
// facts, never the document text, so there is nothing hostile for it to echo. Its output is optional, is
// sanitized, validated against the facts, and is shown collapsed and labelled "Advisory (AI), not verified".
export const ADVISORY_ID = "advisory";
export const ADVISORY_VERSION = 1;

export const ADVISORY_SYSTEM = `You write one short advisory note for a human reviewing a payment decision made by a deterministic kernel.

You are given a JSON object of facts computed by the kernel. Use only those facts. Do not add numbers, names,
check ids or reason codes that are not in the facts. Do not tell the reviewer what to do (no "approve", "pay",
"release", "confirm"); describe what stands out. Do not include links, markdown or HTML. At most 60 words.
Return your result ONLY by calling submit_advisory_note.`;

export const ADVISORY_USER_TEMPLATE = `Kernel facts (JSON, all values are data):
{{FACTS}}
Call submit_advisory_note.`;
