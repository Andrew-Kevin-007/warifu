// End to end: run the real contracts/script/Deploy.s.sol (stock forge, V-19) against a real anvil, then check that
// loadDeployments() accepts the file it wrote and that every recorded value matches the chain. Anvil's unlocked
// accounts sign (`--unlocked --sender`), so no private key is used or stored.
// Skipped with a warning when anvil or forge is missing, unless REQUIRE_ANVIL=1 or CI=true.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, type Abi, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainError, arcChain, assertTokenDecimals, loadDeployments, selectDeployment, symbolonVaultAbi, type DeploymentGroup } from "../src/index";
import { CONTRACTS_DIR, MOCK_USDC_ARTIFACT, readArtifact } from "./helpers/artifacts";
import { anvilAvailable, startAnvil, type AnvilProcess } from "./helpers/anvil-process";

const FORGE = process.env.FORGE_BIN ?? "forge";
const required = process.env.REQUIRE_ANVIL === "1" || process.env.CI === "true";
const haveTools = anvilAvailable() && spawnSync(FORGE, ["--version"], { encoding: "utf8" }).status === 0;
if (!haveTools && !required) console.warn("[chain tests] anvil/forge not found: skipping the Deploy.s.sol end-to-end test");

const REL_FILE = `cache/deploy-test/chain-wp06-${String(process.pid)}.json`; // allowed by contracts/foundry.toml fs_permissions

describe.skipIf(!haveTools && !required)("deployments/*.json written by Deploy.s.sol", () => {
  let anvil: AnvilProcess;
  let pub: ReturnType<typeof createPublicClient>;
  let file: string;
  let group: DeploymentGroup;
  let accounts: Address[];
  let token: Address;

  beforeAll(async () => {
    anvil = await startAnvil();
    const chain = arcChain("local", anvil.url);
    pub = createPublicClient({ chain, transport: http(anvil.url) });
    const wallet = createWalletClient({ chain, transport: http(anvil.url) });
    accounts = (await wallet.getAddresses()).map((a) => getAddress(a));
    const [deployer, owner, kernel, guardian] = accounts as [Address, Address, Address, Address];

    const a = readArtifact(MOCK_USDC_ARTIFACT);
    const tx = await wallet.deployContract({ abi: a.abi as Abi, bytecode: a.bytecode.object, args: [6], account: deployer, chain });
    const receipt = await pub.waitForTransactionReceipt({ hash: tx });
    token = getAddress(receipt.contractAddress as Address);

    file = resolve(CONTRACTS_DIR, REL_FILE);
    const r = spawnSync(
      FORGE,
      ["script", "script/Deploy.s.sol:DeployVault", "--rpc-url", anvil.url, "--unlocked", "--sender", deployer, "--broadcast"],
      {
        cwd: CONTRACTS_DIR,
        encoding: "utf8",
        timeout: 240_000,
        env: {
          ...process.env,
          FOUNDRY_OFFLINE: "true",
          VAULT_PROFILE: "sandbox",
          VAULT_TOKEN: token,
          VAULT_OWNER: owner,
          VAULT_KERNEL_SIGNER: kernel,
          VAULT_GUARDIAN: guardian,
          VAULT_PER_TX_CAP: "25000000",
          VAULT_DAILY_CAP: "60000000",
          VAULT_HOURLY_CAP: "0",
          VAULT_HUMAN_THRESHOLD: "20000000",
          VAULT_PAYEE_CHANGE_DELAY: "172800",
          VAULT_SIGNER_CHANGE_DELAY: "86400",
          GIT_SHA: "wp06-test",
          DEPLOYMENTS_FILE: REL_FILE,
        },
      },
    );
    if (r.status !== 0) throw new Error(`forge script failed: ${r.stderr.slice(0, 800)}`);
    group = selectDeployment(loadDeployments(file), "sandbox");
  }, 300_000);

  afterAll(async () => {
    await anvil?.stop();
    if (file !== undefined && existsSync(file)) rmSync(file);
  });

  it("the loader accepts the real file and reports the inputs", () => {
    const [, owner, kernel, guardian] = accounts as [Address, Address, Address, Address];
    expect(group).toMatchObject({ profile: "sandbox", chainId: 31337, token, owner, kernelSigner: kernel, guardian, tokenDecimals: 6, gitSha: "wp06-test" });
    expect(group.caps.perTxCap).toEqual({ units: 25_000_000n, decimals: 6 });
    expect(group.caps.dailyCap).toEqual({ units: 60_000_000n, decimals: 6 });
    expect(group.caps.humanThreshold).toEqual({ units: 20_000_000n, decimals: 6 });
    expect(group.caps.hourlyCap.units).toBe(0n);
  });

  it("the file matches the chain: code hash, configHash, decimals and immutables", async () => {
    const code = await pub.getCode({ address: group.vault });
    expect(code).toBeDefined();
    expect(keccak256(code as `0x${string}`)).toBe(group.runtimeCodeHash);
    const read = <T extends string>(functionName: T) => pub.readContract({ address: group.vault, abi: symbolonVaultAbi, functionName: functionName as never });
    expect(await read("configHash")).toBe(group.configHash);
    expect(await read("perTxCap")).toBe(group.caps.perTxCap.units);
    expect(await read("owner")).toBe(group.owner);
    expect(await assertTokenDecimals(pub, group.vault, group.tokenDecimals)).toEqual({ token: group.token, decimals: 6 });
  });

  it("negative control: a recorded decimals value that disagrees with the chain is rejected", async () => {
    await expect(assertTokenDecimals(pub, group.vault, group.tokenDecimals + 12)).rejects.toBeInstanceOf(ChainError);
  });
});
