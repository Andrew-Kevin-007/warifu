// Lets plain Node (>= 22.15) run this repo's TypeScript without a build step or a new dependency (`pnpm lbc ...`).
// The workspace imports modules without file extensions (bundler resolution, like Vite and tsc here); Node's own
// resolver wants them. This hook only adds the extension when the specifier is relative (or a workspace file) and
// the extensionless form does not resolve; it never changes what a bare package name resolves to, so `viem`,
// `zod` and friends still come from node_modules. Type syntax is removed by Node itself (--experimental-transform-types).
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const EXTENSIONS = [".ts", "/index.ts"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && context.parentURL?.startsWith("file:")) {
      const base = new URL(specifier, context.parentURL);
      const asPath = fileURLToPath(base);
      if (!(existsSync(asPath) && statSync(asPath).isFile())) {
        for (const ext of EXTENSIONS) {
          const candidate = asPath + ext;
          if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
