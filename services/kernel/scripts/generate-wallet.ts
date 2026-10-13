// Run: node --import tsx services/kernel/scripts/generate-wallet.ts wallet --profile production
// (tsx is not a repo dependency, see src/main.ts; the logic and tests are in src/circle/generate-wallet-cli.ts.)
import { runGenerateWallet } from "../src/circle/generate-wallet-cli";

runGenerateWallet(process.argv.slice(2), process.env, { out: (l) => console.log(l), repoRoot: process.cwd() })
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error("generate-wallet failed (details withheld: the Circle response is untrusted and may echo request data)");
    process.exitCode = 1;
  });
