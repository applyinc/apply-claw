import { exec, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

import { resolveFilesystemPath } from "./filesystem-service.js";

const THUMB_DIR = join(tmpdir(), "denchclaw-thumbs");
try { mkdirSync(THUMB_DIR, { recursive: true }); } catch {}

function safeResolvePath(relativePath: string): string | null {
  const resolved = resolveFilesystemPath(relativePath);
  if (!resolved || !resolved.withinWorkspace) return null;
  return resolved.absolutePath;
}

export async function openFile(body: { path?: string; reveal?: boolean }) {
  const rawPath = body.path;
  if (!rawPath || typeof rawPath !== "string") {
    return { error: "Missing 'path' in request body", status: 400 as const };
  }

  const expanded = rawPath.startsWith("~/")
    ? rawPath.replace(/^~/, homedir())
    : rawPath;

  let resolved = resolve(normalize(expanded));

  // If the file doesn't exist and looks like a bare filename, try mdfind (macOS)
  if (!existsSync(resolved) && !rawPath.includes("/") && process.platform === "darwin") {
    const found = await new Promise<string | null>((res) => {
      exec(
        `mdfind -name ${JSON.stringify(rawPath)} | head -1`,
        (err, stdout) => {
          if (err || !stdout.trim()) res(null);
          else res(stdout.trim().split("\n")[0]);
        },
      );
    });
    if (found && existsSync(found)) {
      resolved = found;
    }
  }

  if (!existsSync(resolved)) {
    return { error: "File not found", status: 404 as const };
  }

  const platform = process.platform;
  const reveal = body.reveal === true;

  let cmd: string;
  if (platform === "darwin") {
    cmd = reveal
      ? `open -R ${JSON.stringify(resolved)}`
      : `open ${JSON.stringify(resolved)}`;
  } else if (platform === "linux") {
    cmd = `xdg-open ${JSON.stringify(resolved)}`;
  } else {
    return { error: `Unsupported platform: ${platform}`, status: 400 as const };
  }

  return new Promise<{ data: { ok: boolean; path: string }; status: 200 } | { error: string; status: 500 }>((res) => {
    exec(cmd, (error) => {
      if (error) {
        res({ error: `Failed to open file: ${error.message}`, status: 500 as const });
      } else {
        res({ data: { ok: true, path: resolved }, status: 200 as const });
      }
    });
  });
}

export function generateThumbnail(path: string, size: string) {
  if (!path) {
    return { error: "Missing path", status: 400 as const };
  }

  let absolute: string | null = null;
  if (path.startsWith("/")) {
    const abs = resolve(path);
    if (existsSync(abs)) absolute = abs;
  }
  if (!absolute) {
    absolute = safeResolvePath(path);
  }

  if (!absolute) {
    return { error: "Not found", status: 404 as const };
  }

  const thumbName = `${basename(absolute)}.png`;
  const thumbPath = join(THUMB_DIR, thumbName);

  try {
    execSync(
      `qlmanage -t -s ${parseInt(size, 10)} -o "${THUMB_DIR}" "${absolute}" 2>/dev/null`,
      { timeout: 5000 },
    );

    if (!existsSync(thumbPath)) {
      return { error: "Thumbnail generation failed", status: 500 as const };
    }

    const buffer = readFileSync(thumbPath);
    return { data: buffer, contentType: "image/png", status: 200 as const };
  } catch {
    return { error: "Thumbnail generation failed", status: 500 as const };
  }
}
