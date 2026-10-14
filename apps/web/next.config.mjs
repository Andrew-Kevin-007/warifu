/* global process */
const CHALLENGE =process.env.NEXT_PUBLIC_PROFILE === 'challenge';

// INV-16: the `challenge` build contains no wallet or signing code. The only importers of src/wallet are server pages
// (owner routes, 404 in this profile); aliasing the three components to inert stubs keeps the wallet module graph out of the bundle.
const challengeAliases = CHALLENGE
  ? {
      '@/wallet/ApprovalPanel': './src/wallet-stub/ApprovalPanel.tsx',
      '@/wallet/WalletButton': './src/wallet-stub/WalletButton.tsx',
      '@/wallet/SignEngagementPanel': './src/wallet-stub/SignEngagementPanel.tsx',
    }
  : {};

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
      ...challengeAliases,
    },
  },
};

export default nextConfig;
