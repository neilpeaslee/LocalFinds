import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  transpilePackages: ["@localfinds/db"],
  async redirects() {
    return [
      // /businesses was renamed to /places in PL1 (2026-07-18). Preserve old
      // links + muscle memory. The wildcard also covers detail pages, whose
      // catch-all osm ids can span multiple segments (e.g. node/12345).
      { source: "/businesses/:path*", destination: "/places/:path*", permanent: true },
      // Conventional alias for the steward login (served by Phoenix at /auth/log-in).
      { source: "/login", destination: "/auth/log-in", permanent: true },
    ];
  },
};

export default nextConfig;
