import type { NextConfig } from "next";

// Reflex backend paths (/app, /auth, /stripe, /_event, /_upload,
// /api/payment, /api/profile) are proxied by src/proxy.ts which
// does explicit fetch + stream rather than Next.js rewrites. Rewrites
// to external URLs with trailing slashes were producing a 308 loop in
// Next.js 16, hence the proxy approach.
const nextConfig: NextConfig = {};

export default nextConfig;
