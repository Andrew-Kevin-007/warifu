// SQL fixtures for the WP-09 database tests. Everything here is synthetic test data (demo:true by nature).
import { run } from "./harness";

let counter = 0;
export const nextN = (): number => ++counter;
export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const hex32 = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
export const sqlText = (s: string): string => `$q$${s}$q$`; // dollar-quoted literal; fixtures never contain "$q$"

export const T_PILOT = uuid(0x101);
export const T_OPTIN = uuid(0x102);
export const T_DEMO = uuid(0x103);
export const T_CHALLENGE = uuid(0x104);

export interface TenantOpts {
  readonly id: string;
  readonly name?: string;
  readonly kind: "pilot" | "demo" | "challenge";
  readonly network?: "testnet" | "mainnet" | "local";
  readonly publicAmounts?: boolean;
}

export function insertTenant(db: string, o: TenantOpts): void {
  run(
    db,
    `insert into tenants (id, name, owner_address, chain_id, network, kind, policy, policy_hash, public_amounts)
     values ('${o.id}', ${sqlText(o.name ?? `tenant-${o.id.slice(-3)}`)}, '0x00000000000000000000000000000000000d3a01', 1,
             '${o.network ?? "testnet"}', '${o.kind}', '{"demo":true}'::jsonb, '${hex32(0)}', ${o.publicAmounts === true});`,
  );
}

export interface DecisionOpts {
  readonly tenantId: string;
  readonly amount: bigint;
  readonly releaseAmount?: bigint;
  readonly verdict?: string;
  readonly checks?: string; // JSON text
  readonly reasons?: string[]; // codes, inserted as a text[] literal
  readonly explanation?: string;
  readonly releaseStatus?: "CONFIRMED" | "SUBMITTED" | "FAILED" | null; // null: no release row
  readonly txHash?: string;
}

/** document -> intent -> decision -> (release) -> receipt. Returns the receipt hash. */
export function insertDecisionChain(db: string, o: DecisionOpts): { receiptHash: string; decisionId: string } {
  const n = nextN();
  const decisionId = uuid(0x1000 + n);
  const receiptHash = hex32(0x2000 + n);
  const intentId = hex32(0x3000 + n);
  const docId = uuid(0x4000 + n);
  const reasons = (o.reasons ?? ["OK"]).map((r) => `"${r.replace(/"/g, '\\"')}"`).join(",");
  const checks = o.checks ?? '[{"id":"K-01","name":"schema","status":"PASS","code":null,"detail":"ok","refs":[]}]';
  const rel =
    o.releaseStatus === null || o.releaseStatus === undefined
      ? ""
      : `insert into releases (decision_id, intent_id, status, attestation, tx_hash, confirmed_at)
         values ('${decisionId}', '${intentId}', '${o.releaseStatus}', '{}'::jsonb, '${o.txHash ?? hex32(0x5000 + n)}',
                 ${o.releaseStatus === "CONFIRMED" ? "now()" : "null"});`;
  run(
    db,
    `insert into documents (document_id, tenant_id, raw_hash, mime, storage_key, normalized_text)
       values ('${docId}', '${o.tenantId}', '${hex32(0x6000 + n)}', 'text/plain', 'k${n}', ${sqlText("invoice text SECRET-INVOICE-BODY")});
     insert into intents (intent_id, tenant_id, document_id, payload) values ('${intentId}', '${o.tenantId}', '${docId}', '{}'::jsonb);
     insert into decisions (decision_id, tenant_id, intent_id, verdict, checks, reasons, payee, amount_base_units, release_amount_base_units,
                            engagement_id, policy_hash, kernel_version, context_hash, human_explanation)
       values ('${decisionId}', '${o.tenantId}', '${intentId}', '${o.verdict ?? "RELEASE"}', ${sqlText(checks)}::jsonb,
               '{${reasons}}'::text[], '0xPAYEE-SECRET-ADDRESS', ${o.amount}, ${o.releaseAmount === undefined ? "null" : o.releaseAmount},
               'ENGAGEMENT-SECRET-ID', '${hex32(0x7000)}', 'k1', '${hex32(0x7001)}', ${sqlText(o.explanation ?? "explanation SECRET-EXPLANATION")});
     ${rel}
     insert into receipts (receipt_hash, decision_id, receipt, signature, signer, issued_at)
       values ('${receiptHash}', '${decisionId}', '{"secret":"SECRET-RECEIPT-BODY"}'::jsonb, '0xsig', '0xsigner', now());`,
  );
  return { receiptHash, decisionId };
}

export function insertTraction(db: string, o: { tenantId: string; network: "testnet" | "mainnet"; amount: bigint; real?: boolean; internal?: boolean }): void {
  run(
    db,
    `insert into traction_events (tenant_id, kind, network, real, internal, amount_base_units)
     values ('${o.tenantId}', 'release', '${o.network}', ${o.real ?? true}, ${o.internal ?? false}, ${o.amount});`,
  );
}

export function setProfile(db: string, profile: "production" | "sandbox"): void {
  run(db, `insert into deployment_profile (id, profile) values (1, '${profile}');`);
}

/** A valid challenge_attempts insert (sandbox DB only). Overrides replace columns by name. */
export function attemptSql(over: Record<string, string> = {}): string {
  const n = nextN();
  const cols: Record<string, string> = {
    scenario_id: `'S-A'`,
    source: `'human'`,
    ip_hash: `'${hex32(0x8000 + n)}'`,
    text_hash: `'${hex32(0x9000 + n)}'`,
    text_length: "12",
    excerpt: `'excerpt'`,
    full_text: `'full text'`,
    extraction: `'{}'::jsonb`,
    verdict: `'REJECT'`,
    reasons: `'{AMOUNT_MISMATCH}'::text[]`,
    checks_fired: `'{K-07}'::text[]`,
    oracle_result: `'NO_LOSS'`,
    oracle_predicates: `'{}'::text[]`,
    benign_control: "false",
    ...over,
  };
  const keys = Object.keys(cols);
  return `insert into challenge_attempts (${keys.join(", ")}) values (${keys.map((k) => cols[k]).join(", ")});`;
}

export function insertScenario(db: string): void {
  run(db, `insert into challenge_scenarios (scenario_id, spec, oracle_version) values ('S-A', '{}'::jsonb, 'oracle-v1') on conflict do nothing;`);
}
