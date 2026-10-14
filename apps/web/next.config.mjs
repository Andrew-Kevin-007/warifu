/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // three / rapier ship ESM with wasm; let Next bundle them for the client
  transpilePackages: ['three'],
};

export default nextConfig;
