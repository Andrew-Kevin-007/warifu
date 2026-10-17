// The challenge service (WP-32, docs/15): attempts, scoreboard, kill switch and the degrade ladder, over the engine. Mounted only
// under KERNEL_PROFILE=sandbox (app.ts); the boot guards (boot.ts G1..G10) already refused a sandbox process with a production
// signer, secret, database or network. Attackers supply DOCUMENTS ONLY: engagements, payees, caps and evidence are fixture state.
//
//   attempt        one-click (ATK-01..24) | benign control | free-form (the visitor's text, read by the extractor behind the budget ledger)
//   scoreboard     ChallengeStats (docs/15 section 8): human vs house vs one-click counted apart; loss rate by the rule of three
//   levels         L0 all · L1 one-click + benign (budget >= 80 %, or no LLM configured) · L2 replay only (budget 100 %, kill switch, DB down)
//
// Logs carry attemptId, ipHash and codes only, never document text. The text is stored as an excerpt, a hash and (30 days) the full
// text; the public surface shows it only through <UntrustedText>.
import { createHash } from "node:crypto";
import * as z from "zod";
import { ATTACK_IDS } from "@symbolon/attack-suite";
import type { AttackId, ScenarioId } from "@symbolon/attack-suite";
import { toExcerpt, untrusted } from "@symbolon/schemas";
import type { ExtractedInvoice } from "@symbolon/schemas";
import { ApiError } from "../errors";
import type { Db } from "../db/pool";
import type { Logger } from "../log";
import { errorFields } from "../log";
import type { Clock } from "../time";
import { benignCatalog, oneClickCatalog, runBenign, runFreeForm, runOneClick, scenarioMilestones, SCENARIO_IDS } from "./engine";
import type { EngineResult } from "./engine";
import { ConcurrencyGate, checkAttemptText, defaultLimits, degradeLevel, ipHash } from "./limits";
import type { ChallengeLimits, DegradeLevel } from "./limits";
import type { PgBudgetLedger } from "./ledger";

export type ExtractOutcome =
  | { readonly ok: true; readonly a: ExtractedInvoice; readonly b: ExtractedInvoice | null }
  | { readonly ok: false; readonly code: string; readonly disposition: "ESCALATE" | "HOLD" };

export interface ChallengeDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  /** CHALLENGE_IP_SALT (boot guard G6). */
  readonly ipSalt: string;
  /** CHALLENGE_ENABLED. */
  readonly enabled: boolean;
  /** CHALLENGE_LLM_DAILY_BUDGET_USD in micro-USD (boot guard G6). */
  readonly dailyBudgetMicroUsd: bigint;
  /** null = no sandbox LLM key / price table: free-form is off and the level is at most L1. */
  readonly ledger: PgBudgetLedger | null;
  readonly extract: ((text: string, principalHash: string) => Promise<ExtractOutcome>) | null;
  readonly limits?: ChallengeLimits;
  readonly gate?: ConcurrencyGate;
  /** The sandbox vault the "prove it on-chain" action would use; null = not configured, the action says so. */
  readonly onchain: { readonly vault: string } | null;
}

const OneClick = z.strictObject({ kind: z.literal("oneclick"), attackId: z.enum(ATTACK_IDS) });
const Benign = z.strictObject({ kind: z.literal("benign"), benignId: z.string().regex(/^[A-Z]{2}-[0-9]{1,2}$/) });
const FreeForm = z.strictObject({
  kind: z.literal("freeform"),
  scenarioId: z.enum(["S-A", "S-B", "S-C"]),
  milestoneSlug: z.string().regex(/^[a-z0-9-]{1,64}$/),
  text: z.unknown(),
});
export const AttemptRequestSchema = z.discriminatedUnion("kind", [OneClick, Benign, FreeForm]);

export interface ChallengeStatus {
  readonly level: DegradeLevel;
  readonly enabled: boolean;
  readonly freeFormAvailable: boolean;
  readonly budgetUsedBp: number;
  readonly source: "live";
}

export interface AttemptView {
  readonly attemptId: string;
  readonly createdAt: string;
  readonly source: "human" | "oneclick";
  readonly result: EngineResult;
  /** Free-form only: what the visitor typed, as an excerpt + length + hash (display through <UntrustedText>). */
  readonly text: { readonly excerpt: string; readonly length: number; readonly hash: string } | null;
  /** Why no verdict from the kernel exists for a free-form attempt (the extractor refused), else null. */
  readonly extractionRefused: string | null;
}

/** 0x-prefixed sha256 hex: the format the challenge_attempts hash columns enforce (migration 0003). */
const sha256 = (s: string): string => `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;

/** The column accepts the five kernel verdicts only; a NOOP (nothing was decided, e.g. a reverted transfer) is stored as HOLD, the result JSON keeps the truth. */
const dbVerdict = (action: string): string => (action === "NOOP" ? "HOLD" : action);

function scenarioTitle(id: ScenarioId): string {
  return id === "S-A" ? "Design contractor (owner acknowledges the work)" : id === "S-B" ? "Developer (green CI is the evidence)" : "Tools vendor (2/10 net 30 terms)";
}

export class ChallengeService {
  private readonly limits: ChallengeLimits;
  private readonly gate: ConcurrencyGate;
  private ensured = false;

  constructor(private readonly d: ChallengeDeps) {
    this.limits = d.limits ?? defaultLimits(d.clock);
    this.gate = d.gate ?? new ConcurrencyGate(3, 20);
  }

  // --- status and catalog -------------------------------------------------------------------------------------------------
  async status(): Promise<ChallengeStatus> {
    let used = 0;
    let healthy = true;
    try {
      const spent = this.d.ledger === null ? 0n : await this.d.ledger.spentTodayMicroUsd();
      used = this.d.dailyBudgetMicroUsd === 0n ? 10_000 : Number((spent * 10_000n) / this.d.dailyBudgetMicroUsd); // bp of a budget: small, safe as a number
    } catch (e) {
      healthy = false;
      this.d.logger.warn("challenge.status_failed", { ...errorFields(e) });
    }
    const llmConfigured = this.d.ledger !== null && this.d.extract !== null;
    const level = degradeLevel({ enabled: this.d.enabled, budgetUsedBp: used, llmConfigured, backendHealthy: healthy });
    return { level, enabled: this.d.enabled, freeFormAvailable: level === "L0", budgetUsedBp: Math.min(used, 10_000), source: "live" };
  }

  async catalog(): Promise<{
    status: ChallengeStatus;
    scenarios: { scenarioId: ScenarioId; title: string; milestones: { slug: string; description: string; amountBaseUnits: string }[] }[];
    oneClick: ReturnType<typeof oneClickCatalog>;
    benign: ReturnType<typeof benignCatalog>;
    rules: { maxTextBytes: number; freeFormPerHour: number; freeFormPerDay: number; oneClickPerHour: number };
  }> {
    return {
      status: await this.status(),
      scenarios: SCENARIO_IDS.map((id) => ({ scenarioId: id, title: scenarioTitle(id), milestones: [...scenarioMilestones(id)] })),
      oneClick: oneClickCatalog(),
      benign: benignCatalog(),
      rules: { maxTextBytes: 4096, freeFormPerHour: 5, freeFormPerDay: 30, oneClickPerHour: 60 },
    };
  }

  // --- attempts ---------------------------------------------------------------------------------------------------------
  async attempt(body: unknown, clientIp: string | null): Promise<AttemptView> {
    const parsed = AttemptRequestSchema.safeParse(body);
    if (!parsed.success) throw new ApiError("BAD_REQUEST", "unrecognised attempt request");
    const req = parsed.data;
    const status = await this.status();
    if (status.level === "L2") throw new ApiError("UNAVAILABLE", "the live challenge is paused; the recorded replay is shown instead", { level: "L2" }, { "Retry-After": "300" });
    if (req.kind === "freeform" && status.level !== "L0") throw new ApiError("UNAVAILABLE", "free-form attempts are off right now (one-click and benign controls still run)", { level: status.level });

    const ip = ipHash(clientIp ?? "unknown", this.d.ipSalt);
    const lim = req.kind === "freeform" ? [this.limits.freeFormHour.hit(ip), this.limits.freeFormDay.hit(ip)] : [this.limits.oneClickHour.hit(ip)];
    const over = lim.find((x) => !x.ok);
    if (over !== undefined) throw new ApiError("RATE_LIMITED", "too many attempts; try again later", { retryAfterSeconds: over.retryAfterSeconds }, { "Retry-After": String(over.retryAfterSeconds) });

    const slot = await this.gate.acquire();
    if (!slot.ok) throw new ApiError("RATE_LIMITED", "the challenge is busy; try again shortly", { retryAfterSeconds: 5 }, { "Retry-After": "5" });
    try {
      return await this.run(req, ip);
    } finally {
      slot.release();
    }
  }

  private async run(req: z.infer<typeof AttemptRequestSchema>, ip: string): Promise<AttemptView> {
    if (req.kind === "oneclick") return this.persist({ source: "oneclick", result: runOneClick(req.attackId as AttackId), ip, text: null, refused: null, benign: false, textHash: sha256(`oneclick:${req.attackId}`) });
    if (req.kind === "benign") {
      const r = runBenign(req.benignId);
      if (r === null) throw new ApiError("NOT_FOUND", "no such benign control");
      return this.persist({ source: "oneclick", result: r, ip, text: null, refused: null, benign: true, textHash: sha256(`benign:${req.benignId}`) });
    }
    // free-form: the text is checked BEFORE anything is spent on it
    const chk = checkAttemptText(req.text);
    if (!chk.ok) throw new ApiError(chk.code === "TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "NOT_TEXT", "the document must be plain UTF-8 text of at most 4096 bytes", { rule: chk.code });
    if (!scenarioMilestones(req.scenarioId).some((m) => m.slug === req.milestoneSlug)) throw new ApiError("BAD_REQUEST", "the milestone is not part of this scenario");
    const extract = this.d.extract;
    if (extract === null) throw new ApiError("UNAVAILABLE", "free-form attempts need the sandbox model key, which is not configured", { level: "L1" });
    const normalized = chk.text.normalize("NFKC");
    const textHash = sha256(`${req.scenarioId}\u0000${normalized}`);
    const shown = { excerpt: toExcerpt(untrusted(chk.text), 240), length: chk.text.length, hash: textHash };
    const read = await extract(chk.text, ip);
    if (!read.ok) {
      // The extractor refused (injection signals, budget, provider error): nothing reaches the kernel, nothing is released: NO_LOSS.
      const refused: EngineResult = {
        engine: "challenge-engine/1", mode: "UNIT", kind: "freeform", attackId: null, benignId: null, scenarioId: req.scenarioId,
        action: read.disposition, checksFired: [], reasons: [read.code], releases: 0, lossReleases: 0, lossBaseUnits: "0", predicates: [],
        oracleResult: "NO_LOSS", outcome: null, benign: null, runs: [], notRun: [], steps: 0,
      };
      return this.persist({ source: "human", result: refused, ip, text: { shown, full: chk.text }, refused: read.code, benign: false, textHash });
    }
    const result = runFreeForm({ scenarioId: req.scenarioId, milestoneSlug: req.milestoneSlug, text: chk.text, a: read.a, b: read.b });
    if (result === null) throw new ApiError("BAD_REQUEST", "the milestone is not part of this scenario");
    return this.persist({ source: "human", result, ip, text: { shown, full: chk.text }, refused: null, benign: false, textHash });
  }

  private async ensureScenarios(): Promise<void> {
    if (this.ensured) return;
    for (const id of SCENARIO_IDS) {
      await this.d.db.query("insert into challenge_scenarios (scenario_id, spec, oracle_version) values ($1, $2::jsonb, 'oracle-v1') on conflict (scenario_id) do nothing", [
        id,
        JSON.stringify({ title: scenarioTitle(id), milestones: scenarioMilestones(id) }),
      ]);
    }
    this.ensured = true;
  }

  private async persist(p: {
    source: "human" | "oneclick";
    result: EngineResult;
    ip: string;
    text: { shown: { excerpt: string; length: number; hash: string }; full: string } | null;
    refused: string | null;
    benign: boolean;
    textHash: string;
  }): Promise<AttemptView> {
    await this.ensureScenarios();
    const r = p.result;
    const ins = await this.d.db.query<{ attempt_id: string; created_at: string }>(
      `insert into challenge_attempts (scenario_id, source, attack_id, ip_hash, text_hash, text_length, excerpt, full_text, extraction, verdict, reasons, checks_fired,
                                       oracle_result, oracle_predicates, benign_control, publishable)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::text[], $12::text[], $13, $14::text[], $15, false)
       returning attempt_id::text, created_at`,
      [
        r.scenarioId, p.source, r.attackId, p.ip, p.textHash, p.text?.shown.length ?? 0, p.text?.shown.excerpt ?? "", p.text?.full ?? null,
        JSON.stringify({ result: r, refused: p.refused }), dbVerdict(r.action), [...r.reasons], [...r.checksFired], r.oracleResult, [...r.predicates], p.benign,
      ],
    );
    const row = ins.rows[0];
    if (row === undefined) throw new ApiError("INTERNAL", "attempt was not stored");
    this.d.logger.info("challenge.attempt", { attemptId: row.attempt_id, ipHash: p.ip.slice(0, 16), reasonCode: r.oracleResult, count: r.releases });
    return { attemptId: row.attempt_id, createdAt: row.created_at, source: p.source, result: r, text: p.text === null ? null : p.text.shown, extractionRefused: p.refused };
  }

  async getAttempt(id: string): Promise<AttemptView> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError("NOT_FOUND", "not found");
    const r = await this.d.db.query<{ attempt_id: string; created_at: string; source: "human" | "oneclick"; extraction: { result: EngineResult; refused: string | null }; text_length: number; excerpt: string; text_hash: string }>(
      "select attempt_id::text, created_at, source, extraction, text_length, excerpt, text_hash from challenge_attempts where attempt_id = $1::uuid and source in ('human','oneclick')",
      [id],
    );
    const x = r.rows[0];
    if (x === undefined) throw new ApiError("NOT_FOUND", "not found");
    return {
      attemptId: x.attempt_id, createdAt: x.created_at, source: x.source, result: x.extraction.result,
      text: x.source === "human" ? { excerpt: x.excerpt, length: x.text_length, hash: x.text_hash } : null,
      extractionRefused: x.extraction.refused,
    };
  }

  // --- scoreboard -------------------------------------------------------------------------------------------------------
  async stats(): Promise<ChallengeStats> {
    const q = this.d.db;
    const one = async <T extends object>(sql: string): Promise<T> => ((await q.query<T>(sql)).rows[0] ?? ({} as T));
    const counts = await one<{ human: string; distinct_human: string; house: string; oneclick: string; ips: string; loss: string; benign_n: string; benign_fail: string }>(
      `select count(*) filter (where source = 'human')::text as human,
              count(distinct text_hash) filter (where source = 'human')::text as distinct_human,
              count(*) filter (where source = 'house')::text as house,
              count(*) filter (where source = 'oneclick')::text as oneclick,
              count(distinct ip_hash) filter (where source = 'human')::text as ips,
              count(*) filter (where oracle_result = 'LOSS')::text as loss,
              count(*) filter (where benign_control)::text as benign_n,
              count(*) filter (where benign_control and verdict <> 'RELEASE')::text as benign_fail
         from challenge_attempts`,
    );
    const outcomes = await q.query<{ verdict: string; n: string }>("select verdict, count(*)::text as n from challenge_attempts group by verdict");
    const preds = await q.query<{ p: string; n: string }>("select p, count(*)::text as n from challenge_attempts, unnest(oracle_predicates) as p where oracle_result = 'LOSS' group by p");
    const codes = await q.query<{ code: string; n: string }>("select code, count(*)::text as n from challenge_attempts, unnest(reasons) as code group by code order by count(*) desc, code limit 8");
    const n = (s: string | undefined): number => Number.parseInt(s ?? "0", 10);
    const distinctHuman = n(counts.distinct_human);
    const lossTotal = n(counts.loss);
    const byOutcome = { RELEASE: 0, HOLD: 0, ESCALATE: 0, REJECT: 0, REPLAY: 0 } as Record<string, number>;
    for (const o of outcomes.rows) if (o.verdict in byOutcome) byOutcome[o.verdict] = n(o.n);
    const byPredicate: Record<string, number> = { O1: 0, O2: 0, O3: 0, O4: 0, O5: 0, O6: 0, O7: 0, O8: 0 };
    for (const p of preds.rows) if (p.p in byPredicate) byPredicate[p.p] = n(p.n);
    return {
      asOf: new Date(this.d.clock()).toISOString(),
      source: "live",
      attempts: { human: n(counts.human), distinctHuman, house: n(counts.house), oneClick: n(counts.oneclick) },
      outcomes: byOutcome as ChallengeStats["outcomes"],
      lossEvents: { total: lossTotal, byPredicate },
      benign: { n: n(counts.benign_n), falseRejects: n(counts.benign_fail) },
      topReasonCodes: codes.rows.map((c) => ({ code: c.code, count: n(c.n) })),
      uniqueAttackers: n(counts.ips),
      certifiedBoundBaseUnits: null,
      observedMaxLossBaseUnits: null,
      // Rule of three, ONLY over distinct human attempts (one-click replays, cache hits and house runs are not independent trials).
      upper95LossRate: lossTotal === 0 && distinctHuman > 0 ? 3 / distinctHuman : null,
    };
  }

  /** The rate-limited "prove it on-chain" action (docs/15 section 2): needs the deployed sandbox vault and a funded relayer. */
  proveOnchain(): never {
    if (this.d.onchain === null) throw new ApiError("NOT_IMPLEMENTED", "no sandbox vault is configured, so there is nothing to prove on-chain yet", { configured: false });
    throw new ApiError("NOT_IMPLEMENTED", "the on-chain showcase is not enabled in this build", { configured: true });
  }
}

export interface ChallengeStats {
  readonly asOf: string;
  readonly source: "live" | "recorded";
  readonly attempts: { readonly human: number; readonly distinctHuman: number; readonly house: number; readonly oneClick: number };
  readonly outcomes: { readonly RELEASE: number; readonly HOLD: number; readonly ESCALATE: number; readonly REJECT: number; readonly REPLAY: number };
  readonly lossEvents: { readonly total: number; readonly byPredicate: Readonly<Record<string, number>> };
  readonly benign: { readonly n: number; readonly falseRejects: number };
  readonly topReasonCodes: readonly { readonly code: string; readonly count: number }[];
  readonly uniqueAttackers: number;
  readonly certifiedBoundBaseUnits: string | null;
  readonly observedMaxLossBaseUnits: string | null;
  /** 3 / distinctHuman when there are no losses (rule of three), else null (not computed here). */
  readonly upper95LossRate: number | null;
}
