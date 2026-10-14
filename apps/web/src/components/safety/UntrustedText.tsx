// The ONLY way attacker-derived strings reach the DOM (INV-15, RT-01). Takes the branded type, never a plain string
// (compile error otherwise; see test/untrusted-text.types.ts), and renders a sanitized single-line excerpt as a TEXT NODE.
// Written with createElement (no JSX) so the unit test can import it without a JSX transform.
import { createElement } from "react";
import { toExcerpt } from "@symbolon/schemas";
import type { Untrusted } from "@symbolon/schemas";

export interface UntrustedTextProps {
  readonly value: Untrusted<string>;
  /** max code points shown (default 240) */
  readonly max?: number;
  readonly className?: string;
}

export function UntrustedText({ value, max = 240, className }: UntrustedTextProps) {
  return createElement("span", { className, "data-untrusted": "true", dir: "auto" }, toExcerpt(value, max));
}
