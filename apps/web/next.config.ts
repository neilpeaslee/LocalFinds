import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  transpilePackages: ["@localfinds/db"],
};

export default nextConfig;
