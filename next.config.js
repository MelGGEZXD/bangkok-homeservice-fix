/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // instrumentation.js (boot hook) is still behind a flag in Next 14.2
    instrumentationHook: true,
    // Do NOT bundle the native better-sqlite3 addon into the server/RSC bundles — keep it
    // external so `output: "standalone"` traces the real .node binary instead.
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

export default nextConfig;
