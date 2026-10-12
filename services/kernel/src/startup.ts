// Startup checks that need the database or the chain (the pure env guards are in boot.ts). All fail closed: a thrown
// StartupError stops the process before it listens. Each message names the rule, never a value.
//   S1  the database is stamped with the SAME deployment profile as KERNEL_PROFILE (INV-16: a production kernel on the
//       sandbox DB, or the reverse, never serves)
//   S2  no tenant of a foreign kind lives in this database (no 'challenge' tenant in production; only 'challenge' in sandbox)
//   S3  the RPC reports the chain id of the configured network
//   S4  the application clock agrees with the database clock (RT-31)
import type { ChainReader } from "./chain/reader";
import { measureClockSkewSeconds } from "./auth/clock-guard";
import { CLOCK_SKEW_SECONDS } from "./auth/token";
import type { Db } from "./db/pool";
import * as repo from "./db/repo";
import type { Profile } from "./boot";
import type { Clock } from "./time";

export class StartupError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(`${rule}: ${message}`);
    this.name = "StartupError";
    this.rule = rule;
  }
}

export async function runStartupChecks(o: { db: Db; chain: ChainReader; profile: Profile; expectedChainId: number; clock: Clock }): Promise<void> {
  let stamped: Profile | null;
  try {
    stamped = await repo.getDeploymentProfile(o.db);
  } catch {
    throw new StartupError("S1", "cannot read deployment_profile (is the database migrated and reachable?)");
  }
  if (stamped === null) throw new StartupError("S1", "the database has no deployment_profile row (run the provisioning script)");
  if (stamped !== o.profile) throw new StartupError("S1", `the database is stamped '${stamped}' but KERNEL_PROFILE is '${o.profile}'`);

  const foreign = await repo.foreignTenantKinds(o.db, o.profile);
  if (foreign.length > 0) throw new StartupError("S2", `the database holds tenants of kind ${foreign.join(",")} that do not belong to the ${o.profile} profile`);

  if (o.chain.chainId !== o.expectedChainId) throw new StartupError("S3", "the chain reader is bound to a different chain id than the configuration");

  let skew: number;
  try {
    skew = await measureClockSkewSeconds(o.db, o.clock);
  } catch {
    throw new StartupError("S4", "cannot read the database clock");
  }
  if (Math.abs(skew) > CLOCK_SKEW_SECONDS) throw new StartupError("S4", "the application clock and the database clock differ by more than the allowed skew");
}

