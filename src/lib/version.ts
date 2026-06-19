// Build/version info surfaced on the health endpoint so an operator (or an
// uptime monitor) can tell which deploy is live. On Vercel these are injected
// automatically; locally they're absent and we fall back to "dev".
export type BuildInfo = {
  version: string; // package version
  commit: string; // git sha (short) or "unknown"
  env: string; // deployment environment (production/preview/development)
};

export function buildInfo(source: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commit =
    source.VERCEL_GIT_COMMIT_SHA ??
    source.GIT_COMMIT_SHA ??
    source.SOURCE_VERSION ??
    "unknown";
  return {
    // npm exposes the package version as npm_package_version when run via npm
    // scripts; both tiers start that way (npm run start / npm run worker).
    version: source.npm_package_version ?? "0.0.0",
    commit: commit === "unknown" ? commit : commit.slice(0, 12),
    env: source.VERCEL_ENV ?? source.NODE_ENV ?? "development",
  };
}
