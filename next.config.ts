import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "11mb",
    },
  },
  typescript: {
    // Supabase env vars are provided at runtime via Vercel; type-check stays on.
    ignoreBuildErrors: false,
  },
};

export default withNextIntl(nextConfig);
