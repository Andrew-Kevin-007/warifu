// Operator commands for a real deployment (docs/OPERATOR_SETUP.md): apply migrations and create a tenant. Run with
//   pnpm kernel:migrate -- --profile production|sandbox
//   pnpm kernel:tenant  -- --name "Acme" --owner 0x... --deployments deployments/testnet.json --policy policy.yaml --kind pilot
// Both read DATABASE_URL from the environment only (never a flag, so it never lands in shell history or logs) and print
// no secret. Fail closed: anything ambiguous is an error and nothing is half-applied.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import { loadDeployments, mainnetChainIdFromEnv, selectDeployment } from "@symbolon/chain";
import type { DeploymentProfile } from "@symbolon/chain";
import { checkPolicyWithinVault, loadPolicy, vaultConfigFromDeployments } from "@symbolon/policy";

/** The minimal client surface used here; `pg.Client` satisfies it. */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsError";
  }
}

const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

export function listMigrations(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  for (const f of files) if (!MIGRATION_NAME.test(f)) throw new OpsError(`unexpected migration file name ${JSON.stringify(f)}`);
  return files.sort();
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
  readonly profile: DeploymentProfile;
}

/**
 * Apply every pending migration in order, each in its own transaction, recording name + sha256 in `ops_migrations`.
 * An applied migration whose file has changed since is an error (migrations are append-only). Then stamp the
 * deployment profile once; a database already stamped with the other profile is refused (INV-16).
 */
export async function migrate(c: SqlClient, dir: string, profile: DeploymentProfile): Promise<MigrateResult> {
  await c.query("create table if not exists ops_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())");
  // RLS on with no policy: only the owner role (the migrator) reads it, consistent with every other base table.
  await c.query("alter table ops_migrations enable row level security");
  const done = new Map((await c.query("select name, sha256 from ops_migrations")).rows.map((r) => [String(r["name"]), String(r["sha256"])]));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const f of listMigrations(dir)) {
    const sql = readFileSync(join(dir, f), "utf8");
    const hash = sha256(sql);
    const prior = done.get(f);
    if (prior !== undefined) {
      if (prior !== hash) throw new OpsError(`migration ${f} changed after it was applied (migrations are append-only)`);
      alreadyApplied.push(f);
      continue;
    }
    await c.query("begin");
    try {
      await c.query(sql);
      await c.query("insert into ops_migrations (name, sha256) values ($1, $2)", [f, hash]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw new OpsError(`migration ${f} failed: ${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}`);
    }
    applied.push(f);
  }
  const stamped = (await c.query("select profile from deployment_profile where id = 1")).rows[0];
  if (stamped === undefined) {
    await c.query("insert into deployment_profile (id, profile) values (1, $1)", [profile]);
  } else if (stamped["profile"] !== profile) {
    throw new OpsError(`this database is stamped ${String(stamped["profile"])}; refusing to use it as ${profile} (INV-16)`);
  }
  return { applied, alreadyApplied, profile };
}

export interface TenantInput {
  readonly name: string;
  readonly owner: string;
  readonly deploymentsPath: string;
  readonly policyYaml: string;
  readonly profile: DeploymentProfile;
  readonly kind: "pilot" | "demo" | "challenge";
  /** ARC_MAINNET_CHAIN_ID, needed only for a mainnet deployments file. */
  readonly mainnetChainId?: number;
}

export interface TenantResult {
  readonly tenantId: string;
  readonly vault: string;
  readonly chainId: number;
  readonly network: string;
  readonly policyHash: string;
}

/** Validate the policy against the deployed vault (a policy may never exceed the vault's caps), then insert the tenant. */
export async function createTenant(c: SqlClient, i: TenantInput): Promise<TenantResult> {
  const name = i.name.trim();
  const hasControl = [...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (name.length < 2 || name.length > 80 || /[<>]/.test(name) || hasControl) throw new OpsError("--name must be 2-80 printable characters without < or >");
  if (!isAddress(i.owner, { strict: false })) throw new OpsError("--owner must be a 0x address");
  if (i.profile === "sandbox" && i.kind !== "challenge" && i.kind !== "demo") throw new OpsError("a sandbox tenant is kind challenge or demo, never pilot (INV-17)");
  if (i.profile === "production" && i.kind === "challenge") throw new OpsError("a challenge tenant lives only in the sandbox (INV-16)");
  const deployments = loadDeployments(i.deploymentsPath, i.mainnetChainId === undefined ? {} : { mainnetChainId: i.mainnetChainId });
  const group = selectDeployment(deployments, i.profile);
  const owner = getAddress(i.owner);
  if (owner !== getAddress(group.owner)) throw new OpsError("--owner is not the vault owner recorded in the deployments file");
  const loaded = loadPolicy(i.policyYaml);
  const raw: unknown = JSON.parse(readFileSync(i.deploymentsPath, "utf8"));
  const violations = checkPolicyWithinVault(loaded, vaultConfigFromDeployments(raw, i.profile));
  if (violations.length > 0) throw new OpsError(`policy exceeds the vault: ${violations.map((v) => `${v.path}: ${v.message}`).join("; ").slice(0, 400)}`);
  const row = (
    await c.query(
      `insert into tenants (name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning id`,
      [name, owner.toLowerCase(), group.vault.toLowerCase(), group.chainId, deployments.network, i.kind, JSON.stringify(loaded.policy), loaded.policyHash],
    )
  ).rows[0];
  if (row === undefined) throw new OpsError("tenant insert returned no row");
  return { tenantId: String(row["id"]), vault: group.vault, chainId: group.chainId, network: deployments.network, policyHash: loaded.policyHash };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseProfile(v: string | undefined): DeploymentProfile {
  if (v !== "production" && v !== "sandbox") throw new OpsError("--profile production|sandbox is required");
  return v;
}

export interface OpsIo {
  readonly out: (line: string) => void;
  readonly connect: (url: string) => Promise<SqlClient & { end(): Promise<void> }>;
  readonly migrationsDir: string;
}

/** CLI body; returns the exit code. */
export async function runOps(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: OpsIo): Promise<number> {
  const cmd = argv[0];
  const url = env["DATABASE_URL"] ?? "";
  if (cmd !== "migrate" && cmd !== "tenant") {
    io.out("usage: ops migrate --profile production|sandbox | ops tenant --name <n> --owner <0x> --deployments <file> --policy <yaml> --profile <p> --kind pilot|demo|challenge");
    return 2;
  }
  if (url === "") {
    io.out("DATABASE_URL must be set in the environment");
    return 2;
  }
  let client: (SqlClient & { end(): Promise<void> }) | null = null;
  try {
    const profile = parseProfile(flag(argv, "profile"));
    client = await io.connect(url);
    if (cmd === "migrate") {
      const r = await migrate(client, io.migrationsDir, profile);
      io.out(`applied ${String(r.applied.length)} migration(s)${r.applied.length ? `: ${r.applied.join(", ")}` : ""}; ${String(r.alreadyApplied.length)} already applied; profile ${r.profile}`);
      return 0;
    }
    const kind = flag(argv, "kind");
    if (kind !== "pilot" && kind !== "demo" && kind !== "challenge") throw new OpsError("--kind pilot|demo|challenge is required");
    const policyPath = flag(argv, "policy");
    const deploymentsPath = flag(argv, "deployments");
    if (policyPath === undefined || deploymentsPath === undefined) throw new OpsError("--policy and --deployments are required");
    const mainnetChainId = mainnetChainIdFromEnv(env);
    const r = await createTenant(client, {
      name: flag(argv, "name") ?? "",
      owner: flag(argv, "owner") ?? "",
      deploymentsPath,
      policyYaml: readFileSync(policyPath, "utf8"),
      profile,
      kind,
      ...(mainnetChainId === undefined ? {} : { mainnetChainId }),
    });
    io.out(`WEB_SVC_TENANT_ID=${r.tenantId}`);
    io.out(`# ${r.network} (chain ${String(r.chainId)}), vault ${r.vault}, policy ${r.policyHash}`);
    return 0;
  } catch (e) {
    io.out(`error: ${e instanceof Error ? e.message : "unknown error"}`);
    return 1;
  } finally {
    await client?.end();
  }
}
