// @symbolon/kernel-service — the Hono service host (WP-10). Process entry: ./main.ts. Wiring: ./app.ts.
export const SERVICE_NAME = "symbolon-kernel" as const;

export { createApp } from "./app";
export type { AppDeps } from "./app";
