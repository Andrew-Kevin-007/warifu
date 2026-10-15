// Run (repo root): pnpm kernel:migrate -- --profile production   |   pnpm kernel:tenant -- --name ... (see src/ops.ts)
import { join } from "node:path";
import pg from "pg";
import { runOps } from "../src/ops";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
runOps(process.argv.slice(2).filter((a) => a !== "--"), process.env, {
  out: (l) => console.log(l),
  migrationsDir: MIGRATIONS,
  connect: async (url) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return c as unknown as Awaited<ReturnType<Parameters<typeof runOps>[2]["connect"]>>;
  },
}).then((code) => {
  process.exitCode = code;
});
