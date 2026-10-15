// Stand-in for lib/supabase/server-client (OURS): an in-memory answer for the calls the route makes.
import { edge } from "./edges";

interface Settled {
  readonly data: unknown;
  readonly error: { message: string } | null;
}

class Query implements PromiseLike<Settled> {
  constructor(
    private readonly table: string,
    private readonly update: Record<string, unknown> | null,
  ) {}

  select(_cols?: string): Query {
    return this;
  }

  eq(_col: string, _value: unknown): Query {
    return this;
  }

  async single(): Promise<Settled> {
    if (this.table === "escrow_agreements" && edge.agreement !== null) return { data: edge.agreement, error: null };
    return { data: null, error: { message: "not found" } };
  }

  then<R1 = Settled, R2 = never>(onfulfilled?: ((v: Settled) => R1 | PromiseLike<R1>) | null, onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    if (this.update !== null && typeof this.update["status"] === "string") edge.statusUpdates.push(this.update["status"]);
    return Promise.resolve<Settled>({ data: null, error: null }).then(onfulfilled, onrejected);
  }
}

export function createSupabaseServerClient() {
  return {
    auth: { getUser: async () => ({ data: { user: edge.user } }) },
    from: (table: string) => ({
      select: (cols?: string) => new Query(table, null).select(cols),
      update: (values: Record<string, unknown>) => new Query(table, values),
    }),
    storage: { from: (_bucket: string) => ({ upload: async (_path: string, _file: unknown, _opts?: unknown) => ({ error: null }) }) },
  };
}
