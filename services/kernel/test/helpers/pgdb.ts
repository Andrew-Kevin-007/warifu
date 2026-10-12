// Real-Postgres fixture for the service tests: a throwaway symbolon_test_* database created by the WP-09 harness, with
// every migration applied, and a real `pg` pool on it. No in-memory stand-in (the brief forbids pg-mem).
import { createPgDb } from "../../src/db/pool";
import type { Db } from "../../src/db/pool";
import { applyMigrations, createDb, dbSuiteEnabled, dropDb, pgConfig, run } from "../db/harness";

export { dbSuiteEnabled, run };

export interface TestDb {
  readonly name: string;
  readonly db: Db;
  readonly url: string;
  close(): Promise<void>;
}

export function urlFor(name: string): string {
  return `postgres://${pgConfig.user}@${pgConfig.host}:${pgConfig.port}/${name}`;
}

/** Create a database, apply all migrations, set its deployment profile, and open a pool. */
export function openTestDb(profile: "production" | "sandbox" = "production"): TestDb {
  const name = createDb();
  applyMigrations(name);
  run(name, `insert into deployment_profile (id, profile) values (1, '${profile}');`);
  const url = urlFor(name);
  const db = createPgDb({ connectionString: url, max: 4 });
  return {
    name,
    db,
    url,
    async close() {
      await db.close();
      dropDb(name);
    },
  };
}
