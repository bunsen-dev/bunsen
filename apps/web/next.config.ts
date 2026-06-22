import type { NextConfig } from "next";

// The four JSON schemas are emitted to public/ by scripts/sync-schemas.mjs and
// served as static assets at the site root (e.g. /experiment.v1.json). The
// schemas.bunsen.dev subdomain is a plain domain alias of this same project, so
// https://schemas.bunsen.dev/experiment.v1.json resolves to the same file with
// Content-Type: application/json (automatic for .json). We only add open CORS so
// editor `$schema` fetches from other origins succeed — no host-aware routing.
const CORS = { key: "Access-Control-Allow-Origin", value: "*" };
const CACHE = { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" };

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:schema(project|suite|experiment|agent).v1.json",
        headers: [CORS, CACHE],
      },
    ];
  },
};

export default nextConfig;
