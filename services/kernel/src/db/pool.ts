// Thin Postgres access (real `pg`; the integration tests run against a real Postgres, never an in-memory stand-in).
// Everything the service does to the DB goes through Queryable, so repositories work the same inside and outside a
// transaction. Types: timestamptz is returned as the raw server string (repo code turns it into whole-second ISO);
// numeric/bigint stay strings (money is never a JS number, INV-10).
import pg from "pg";

export interface QueryResultLike<R> {
  readonly rows: R[];
  readonly rowCount: number;
}

export interface Queryable {
  query<R extends object = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<R>>;
}

export interface Db extends Queryable {
  /** Run `fn` in one transaction (COMMIT on return, ROLLBACK on throw). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Resolves if the database answers `select 1`; rejects otherwise. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;

export interface PgOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
}

export function createPgDb(o: PgOptions): Db {
  const pool = new pg.Pool({
    connectionString: o.connectionString,
    max: o.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: o.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: o.applicationName ?? "symbolon-kernel",
    options: "-c timezone=UTC",
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") => {
        if (oid === TIMESTAMPTZ_OID || oid === TIMESTAMP_OID) return (v: string): string => v;
        return pg.types.getTypeParser(oid, format as "text");
      }) as typeof pg.types.getTypeParser,
    },
  });
  // A pooled idle client may emit an error (server restart); without a listener Node would crash the process.
  pool.on("error", () => undefined);

  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<R extends object>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<R>> {
      const r = await c.query(text, values === undefined ? undefined : [...values]);
      return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
    },
  });
  const direct = wrap(pool);

  return {
    query: (text, values) => direct.query(text, values),
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        try {
          await client.query("rollback");
        } catch {
          // the connection is gone; the original error is the one that matters
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async ping(): Promise<void> {
      await pool.query("select 1");
    },
    close: () => pool.end(),
  };
}
