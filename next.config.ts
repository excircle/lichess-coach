import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon and the Agent SDK spawns its bundled CLI at a
  // path relative to its package dir — neither survives bundling (PLAN.md amendment A5).
  serverExternalPackages: ["better-sqlite3", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
