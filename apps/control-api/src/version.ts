import { createRequire } from "node:module";

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version?.trim() || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function readOpenClawVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("openclaw/package.json") as { version?: string };
    return pkg.version?.trim() || null;
  } catch {
    return null;
  }
}

export function resolveControlApiVersion() {
  return readPackageVersion();
}

export function resolveBundledOpenClawVersion() {
  return readOpenClawVersion();
}
