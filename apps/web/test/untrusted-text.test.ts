import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { untrusted } from "@symbolon/schemas";
import { UntrustedText } from "../src/components/safety/UntrustedText";

const PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '"><svg/onload=alert(1)>',
  "javascript:alert(1)",
  "</span><iframe src=//evil></iframe>",
  "{{constructor.constructor('alert(1)')()}}",
  "‮evil‬​ text",
];

describe("<UntrustedText> (INV-15, RT-01)", () => {
  it.each(PAYLOADS)("renders %j as inert text", (p) => {
    const html = renderToStaticMarkup(createElement(UntrustedText, { value: untrusted(p) }));
    expect(html).not.toMatch(/<(script|img|svg|iframe)/i);
    expect(html).toMatch(/^<span /);
    expect(html.match(/</g)?.length).toBe(2); // only the span open/close tags
  });
  it("strips hidden and bidi characters and truncates", () => {
    const html = renderToStaticMarkup(createElement(UntrustedText, { value: untrusted(`a​b‮${"x".repeat(500)}`), max: 20 }));
    expect(html).not.toContain("​");
    expect(html).not.toContain("‮");
    expect(html).toContain("…");
  });
});
