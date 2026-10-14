/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // three / rapier ship ESM with wasm; workspace packages ship TypeScript source.
  transpilePackages: ['three', '@symbolon/schemas', '@symbolon/receipts', '@symbolon/blast-radius', '@symbolon/chain', '@symbolon/policy'],
  turbopack: {
    // @symbolon/chain's index also exports a deployment-file loader that reads node:fs. The browser verifier only uses its
    // ABI and event decoders, so in the browser bundle the module resolves to an empty stub (the loader is never called).
    resolveAlias: {
      'node:fs': { browser: './src/lib/empty-module.ts' },
      fs: { browser: './src/lib/empty-module.ts' },
    },
  },
};

export default nextConfig;
