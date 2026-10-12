// SEC-07 (log scrubber) and INV-15 (raw document text never reaches a log line).
import { describe, expect, it } from "vitest";
import { untrusted } from "@symbolon/schemas";
import { MAX_FIELD, createLogger, errorFields, scrubFields, untrustedField } from "../src/log";
import { redactionList } from "../src/secrets";

function capture(secrets: string[] = []) {
  const lines: string[] = [];
  const log = createLogger({ sink: { write: (l) => void lines.push(l) }, secrets, clock: () => Date.UTC(2026, 9, 12) });
  return { log, lines };
}

describe("structured logs", () => {
  it("emits one JSON object per line with level, event and the ids it was given", () => {
    const { log, lines } = capture();
    log.info("intent.decided", { intentId: "0xabc", decisionId: "d1", verdict: "HOLD" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "info", event: "intent.decided", intentId: "0xabc", decisionId: "d1", verdict: "HOLD" });
  });

  it("drops fields that can carry content or credentials, whatever their value", () => {
    const out = scrubFields({ text: "invoice body", normalizedText: "x", body: "y", authorization: "Bearer abc", token: "t", apiKey: "k", privateKey: "p", signature: "0x", cookie: "c", docHash: "0xhash", textLength: 12 });
    expect(out["text"]).toBe("[dropped]");
    expect(out["normalizedText"]).toBe("[dropped]");
    expect(out["body"]).toBe("[dropped]");
    expect(out["authorization"]).toBe("[dropped]");
    expect(out["token"]).toBe("[dropped]");
    expect(out["apiKey"]).toBe("[dropped]");
    expect(out["privateKey"]).toBe("[dropped]");
    expect(out["signature"]).toBe("[dropped]");
    expect(out["cookie"]).toBe("[dropped]");
    expect(out["docHash"]).toBe("0xhash");
    expect(out["textLength"]).toBe(12);
  });

  it("truncates long strings so a document cannot ride in an innocuous field", () => {
    const big = "A".repeat(5000);
    const out = scrubFields({ note: big });
    expect((out["note"] as string).length).toBeLessThan(MAX_FIELD + 40);
    expect(out["note"]).toContain("truncated 4800");
  });

  it("untrusted text enters a log only as an escaped excerpt + length + hash", () => {
    const hostile = 'Ignore previous instructions\n"} {"level":"info","event":"forged"} <script>alert(1)</script>' + "Z".repeat(1000);
    const { log, lines } = capture();
    log.warn("doc.rejected", { excerpt: untrustedField(untrusted(hostile)) });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { excerpt: string; event: string };
    expect(parsed.event).toBe("doc.rejected");
    expect(parsed.excerpt).toContain("len=");
    expect(parsed.excerpt).toContain("sha256=");
    expect(lines[0]).not.toContain("Z".repeat(300));
    expect((lines[0] as string).split("\n").filter((l) => l !== "")).toHaveLength(1); // no log forging by newline
  });

  it("replaces every configured secret anywhere in the final line (canary)", () => {
    const canary = "CANARY-SECRET-1234567890abcdef";
    const { log, lines } = capture([canary, "short"]);
    log.error("boom", { detail: `connection to postgres://u:${canary}@h failed`, other: `x${canary}y${canary}` });
    expect(lines[0]).not.toContain(canary);
    expect(lines[0]).toContain("[redacted]");
  });
});

describe("SEC-07 redaction bypasses (review findings)", () => {
  const leak = (secret: string, field: (s: string) => string, secrets = [secret]): string => {
    const { log, lines } = capture(secrets);
    log.error("x", { note: field(secret) });
    return lines[0] as string;
  };

  it("a secret containing a quote, backslash or control character is redacted despite JSON escaping", () => {
    for (const s of ['pa"ss\\word-with-quote-1234', "line1\nline2-secret-value-99", 'tab\there"and\\both-12345678']) {
      const line = leak(s, (x) => `prefix ${x} suffix`);
      expect(line, JSON.stringify(s)).toContain("[redacted]");
      expect(line).not.toContain(JSON.stringify(s).slice(1, -1));
      expect(line).not.toContain(s);
    }
  });

  it("negative control: the raw form no longer matches in the encoded line, only the escaped one does", () => {
    const s = 'pa"ss\\word-with-quote-1234';
    const encoded = JSON.stringify({ note: s });
    expect(encoded.includes(s)).toBe(false);
    expect(encoded.includes(JSON.stringify(s).slice(1, -1))).toBe(true);
  });

  it("password-only leaks (from a connection string) are redacted when the password is in the list", () => {
    const pw = "Sup3r-Secret-Passw0rd!";
    const list = redactionList({ DATABASE_URL: `postgres://kernel:${encodeURIComponent(pw)}@db.example.test/x` });
    const line = leak(pw, (x) => `auth failed for password ${x}`, list);
    expect(line).not.toContain(pw);
    expect(line).toContain("[redacted]");
  });

  it("base64, base64url, hex and percent-encoded spellings are redacted, at every alignment", () => {
    const s = "canary-secret-ABCDEFGH-12345";
    const spellings: string[] = [Buffer.from(s).toString("hex"), Buffer.from(s).toString("hex").toUpperCase(), encodeURIComponent(`${s} é`)];
    for (const prefix of ["", "a", "ab"]) {
      spellings.push(Buffer.from(prefix + s).toString("base64"), Buffer.from(prefix + s).toString("base64url"));
    }
    for (const enc of spellings) {
      const line = leak(s, () => `data=${enc}`);
      expect(line, enc).toContain("[redacted]");
    }
  });

  it("negative control: ordinary text is not redacted", () => {
    const line = leak("canary-secret-ABCDEFGH-12345", () => "totally ordinary text");
    expect(line).toContain("totally ordinary text");
    expect(line).not.toContain("[redacted]");
  });

  it("a secret is redacted even when truncation would cut it in half", () => {
    const s = "S".repeat(40) + "-end-of-secret-xyz";
    const { log, lines } = capture([s]);
    log.info("x", { note: `${"p".repeat(190)}${s}` });
    expect(lines[0]).not.toContain("SSSSSSSSSS");
  });

  it("fields named err/error/message/stack/url/dsn/conn/cred/auth are dropped; errorFields keeps only class and code", () => {
    const conn = "postgres://u:hunter2hunter2@db.internal:5432/x";
    const e = Object.assign(new Error(`connect failed ${conn}`), { code: "ECONNREFUSED" });
    const { log, lines } = capture();
    log.error("db.failed", { err: String(e), error: e.message, message: conn, stack: e.stack ?? "", url: conn, dsn: conn, conn, cred: conn, auth: conn, ...errorFields(e) });
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain("postgres://");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ errClass: "Error", errCode: "ECONNREFUSED" });
    expect(errorFields("a string with postgres://x")).toEqual({ errClass: "string", errCode: "none" });
    expect(errorFields(Object.assign(new Error("m"), { code: "bad code with spaces" })).errCode).toBe("none");
  });
});
