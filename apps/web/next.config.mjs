/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // three / rapier ship ESM with wasm; workspace packages ship TypeScript source.
  transpilePackages: ['three', '@symbolon/schemas', '@symbolon/receipts', '@symbolon/blast-radius', '@symbolon/chain', '@symbolon/policy'],
};

export default nextConfig;
