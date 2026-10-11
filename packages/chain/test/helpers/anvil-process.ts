// Starts a stock `anvil` (local only; V-19: stock Foundry is the dev loop, not arc-anvil) on a free loopback port.
// Anvil's pre-funded accounts are unlocked, so tests sign through the node and no private key appears
// anywhere in the repo.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface AnvilProcess {
  readonly url: string;
  stop(): Promise<void>;
}

const ANVIL_BIN = process.env.ANVIL_BIN ?? "anvil";

export function anvilAvailable(): boolean {
  const r = spawnSync(ANVIL_BIN, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.error === undefined && r.status === 0;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function rpcChainId(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result;
  } catch {
    return undefined;
  }
}

export async function startAnvil(chainId = 31337): Promise<AnvilProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child: ChildProcess = spawn(
    ANVIL_BIN,
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"],
    { stdio: "ignore" },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const expected = `0x${chainId.toString(16)}`;
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error("anvil exited during startup");
    if ((await rpcChainId(url)) === expected) {
      return {
        url,
        stop: () =>
          new Promise<void>((done) => {
            if (exited) return done();
            child.once("exit", () => done());
            child.kill();
          }),
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("anvil did not become ready within 10 s");
}
