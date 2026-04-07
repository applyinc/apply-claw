import {
  cpSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { homedir } from "node:os";

import { resolveWorkspaceRoot } from "./workspace-service.js";

type ResolvedFilesystemPath = {
  absolutePath: string;
  withinWorkspace: boolean;
  workspaceRelativePath: string | null;
};

const ALWAYS_SYSTEM_PATTERNS = [/^\.object\.yaml$/, /\.wal$/, /\.tmp$/];
const ROOT_ONLY_SYSTEM_PATTERNS = [/^workspace\.duckdb/, /^workspace_context\.yaml$/];
const ASSET_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
const RAW_MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
};
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
const BROWSE_SKIP_DIRS = new Set(["node_modules", ".git", ".Trash", "__pycache__", ".cache"]);
const BROWSE_FILE_MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
};
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs",
  "java", "kt", "swift", "c", "cpp", "h", "hpp", "cs", "css", "scss",
  "less", "html", "htm", "xml", "json", "jsonc", "toml", "sh", "bash",
  "zsh", "fish", "ps1", "sql", "graphql", "gql", "dockerfile", "makefile",
  "r", "lua", "php", "vue", "svelte", "diff", "patch", "ini", "env",
  "tf", "proto", "zig", "elixir", "ex", "erl", "hs", "scala", "clj", "dart",
]);

function toPortableRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isPathWithinRoot(root: string, absolutePath: string): boolean {
  const rel = relative(resolve(root), resolve(absolutePath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${"/"}`));
}

function isSystemFile(relativePath: string): boolean {
  const base = relativePath.split("/").pop() ?? "";
  if (ALWAYS_SYSTEM_PATTERNS.some((pattern) => pattern.test(base))) {
    return true;
  }
  const isRoot = !relativePath.includes("/");
  return isRoot && ROOT_ONLY_SYSTEM_PATTERNS.some((pattern) => pattern.test(base));
}

export function resolveFilesystemPath(
  inputPath: string,
  options: { allowMissing?: boolean } = {},
): ResolvedFilesystemPath | null {
  const workspaceRoot = resolveWorkspaceRoot();
  let absolutePath: string;

  if (inputPath.startsWith("~/")) {
    absolutePath = resolve(process.env.HOME ?? "", inputPath.slice(2));
  } else if (inputPath.startsWith("/")) {
    absolutePath = resolve(normalize(inputPath));
  } else {
    if (!workspaceRoot) {
      return null;
    }
    absolutePath = resolve(workspaceRoot, normalize(inputPath));
    if (!isPathWithinRoot(workspaceRoot, absolutePath)) {
      return null;
    }
  }

  if (!options.allowMissing && !existsSync(absolutePath)) {
    return null;
  }

  const withinWorkspace = !!workspaceRoot && isPathWithinRoot(workspaceRoot, absolutePath);
  const workspaceRelativePath = withinWorkspace && workspaceRoot
    ? toPortableRelativePath(relative(resolve(workspaceRoot), absolutePath))
    : null;

  return {
    absolutePath,
    withinWorkspace,
    workspaceRelativePath,
  };
}

function isProtectedSystemPath(resolvedPath: ResolvedFilesystemPath | null): boolean {
  if (!resolvedPath?.withinWorkspace || resolvedPath.workspaceRelativePath == null) {
    return false;
  }
  return isSystemFile(resolvedPath.workspaceRelativePath);
}

function safeResolveNewPath(relativePath: string): string | null {
  const resolvedPath = resolveFilesystemPath(relativePath, { allowMissing: true });
  if (!resolvedPath || !resolvedPath.withinWorkspace) {
    return null;
  }
  return resolvedPath.absolutePath;
}

function readWorkspaceFile(relativePath: string): { content: string; type: "markdown" | "yaml" | "text" } | null {
  const resolved = resolveFilesystemPath(relativePath);
  if (!resolved?.withinWorkspace) {
    return null;
  }

  try {
    const content = readFileSync(resolved.absolutePath, "utf-8");
    const ext = relativePath.split(".").pop()?.toLowerCase();
    let type: "markdown" | "yaml" | "text" = "text";
    if (ext === "md" || ext === "mdx") type = "markdown";
    else if (ext === "yaml" || ext === "yml") type = "yaml";
    return { content, type };
  } catch {
    return null;
  }
}

function resolveRawFile(path: string): string | null {
  const resolvedPath = resolveFilesystemPath(path);
  if (resolvedPath) {
    return resolvedPath.absolutePath;
  }

  const root = resolveWorkspaceRoot();
  if (!root) {
    return null;
  }
  const rootAbs = resolve(root);
  const base = path.split("/").pop() ?? path;
  if (base === path) {
    const subdirs = ["assets", "knowledge", "manufacturing", "uploads", "files", "images", "media", "reports", "exports"];
    for (const sub of subdirs) {
      const candidate = resolve(root, sub, base);
      if (candidate.startsWith(rootAbs) && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function getWorkspaceFile(path: string) {
  if (!path) {
    return { error: "Missing 'path' query parameter", status: 400 as const };
  }
  const file = readWorkspaceFile(path);
  if (!file) {
    return { error: "File not found or access denied", status: 404 as const };
  }
  return { data: file, status: 200 as const };
}

export function writeWorkspaceFile(path: string, content: string) {
  if (!path || typeof content !== "string") {
    return { error: "Missing 'path' and 'content' fields", status: 400 as const };
  }
  const targetPath = resolveFilesystemPath(path, { allowMissing: true });
  if (isProtectedSystemPath(targetPath)) {
    return { error: "Cannot modify system file", status: 403 as const };
  }
  if (!targetPath) {
    return { error: "Invalid path or path traversal rejected", status: 400 as const };
  }
  try {
    mkdirSync(dirname(targetPath.absolutePath), { recursive: true });
    writeFileSync(targetPath.absolutePath, content, "utf-8");
    return { data: { ok: true, path }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Write failed", status: 500 as const };
  }
}

export function deleteWorkspaceFile(path: string) {
  if (!path) {
    return { error: "Missing 'path' field", status: 400 as const };
  }
  const targetPath = resolveFilesystemPath(path);
  if (isProtectedSystemPath(targetPath)) {
    return { error: "Cannot delete system file", status: 403 as const };
  }
  const absolutePath = targetPath?.absolutePath ?? null;
  if (!absolutePath) {
    return { error: "File not found or path traversal rejected", status: 404 as const };
  }
  try {
    const stats = statSync(absolutePath);
    rmSync(absolutePath, { recursive: stats.isDirectory() });
    return { data: { ok: true, path }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Delete failed", status: 500 as const };
  }
}

export function getRawFile(path: string) {
  if (!path) {
    return { error: "Missing path", status: 400 as const };
  }
  const absolutePath = resolveRawFile(path);
  if (!absolutePath) {
    return { error: "Not found", status: 404 as const };
  }
  try {
    const buffer = readFileSync(absolutePath);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return {
      buffer,
      contentType: RAW_MIME_MAP[ext] ?? "application/octet-stream",
      status: 200 as const,
    };
  } catch {
    return { error: "Read error", status: 500 as const };
  }
}

export function writeRawFile(path: string, buffer: Buffer) {
  if (!path) {
    return { error: "Missing path", status: 400 as const };
  }
  const targetPath = resolveFilesystemPath(path, { allowMissing: true });
  if (isProtectedSystemPath(targetPath)) {
    return { error: "Cannot modify system file", status: 403 as const };
  }
  if (!targetPath) {
    return { error: "Invalid path or path traversal rejected", status: 400 as const };
  }
  try {
    mkdirSync(dirname(targetPath.absolutePath), { recursive: true });
    writeFileSync(targetPath.absolutePath, buffer);
    return { data: { ok: true, path }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Write failed", status: 500 as const };
  }
}

export function getAssetFile(assetRelativePath: string) {
  const ext = extname(assetRelativePath).toLowerCase();
  const mime = ASSET_MIME_MAP[ext];
  if (!mime) {
    return { error: "Unsupported file type", status: 400 as const };
  }
  const absolutePath = resolveFilesystemPath(assetRelativePath);
  if (!absolutePath?.withinWorkspace || !existsSync(absolutePath.absolutePath)) {
    return { error: "Not found", status: 404 as const };
  }
  try {
    return {
      buffer: readFileSync(absolutePath.absolutePath),
      contentType: mime,
      status: 200 as const,
    };
  } catch {
    return { error: "Read error", status: 500 as const };
  }
}

export async function uploadWorkspaceFile(file: File) {
  const root = resolveWorkspaceRoot();
  if (!root) {
    return { error: "Workspace not found", status: 500 as const };
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return { error: "File is too large (max 25 MB)", status: 400 as const };
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  const relativePath = join("assets", `${Date.now()}-${safeName}`);
  const absolutePath = safeResolveNewPath(relativePath);
  if (!absolutePath) {
    return { error: "Invalid path", status: 400 as const };
  }
  try {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, Buffer.from(await file.arrayBuffer()));
    return { data: { ok: true, path: relativePath }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Upload failed", status: 500 as const };
  }
}

type BrowseNode = {
  name: string;
  path: string;
  type: "folder" | "file" | "document" | "database";
  children?: BrowseNode[];
  symlink?: boolean;
};

function resolveEntryType(entry: Dirent, absolutePath: string): "directory" | "file" | null {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) {
    try {
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) return "directory";
      if (stats.isFile()) return "file";
    } catch {}
  }
  return null;
}

function buildBrowseTree(
  absoluteDir: string,
  maxDepth: number,
  currentDepth = 0,
  showHidden = false,
): BrowseNode[] {
  if (currentDepth >= maxDepth) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const filtered = entries
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .filter((entry) => {
      const absolutePath = join(absoluteDir, entry.name);
      const type = resolveEntryType(entry, absolutePath);
      return !(type === "directory" && BROWSE_SKIP_DIRS.has(entry.name));
    })
    .toSorted((left, right) => {
      const leftType = resolveEntryType(left, join(absoluteDir, left.name));
      const rightType = resolveEntryType(right, join(absoluteDir, right.name));
      const leftDir = leftType === "directory";
      const rightDir = rightType === "directory";
      if (leftDir && !rightDir) return -1;
      if (!leftDir && rightDir) return 1;
      return left.name.localeCompare(right.name);
    });

  return filtered.flatMap((entry) => {
    const absolutePath = join(absoluteDir, entry.name);
    const effectiveType = resolveEntryType(entry, absolutePath);
    const symlink = entry.isSymbolicLink() ? { symlink: true } : {};

    if (effectiveType === "directory") {
      const children = buildBrowseTree(absolutePath, maxDepth, currentDepth + 1, showHidden);
      return [{
        name: entry.name,
        path: absolutePath,
        type: "folder",
        children: children.length > 0 ? children : undefined,
        ...symlink,
      } satisfies BrowseNode];
    }

    if (effectiveType === "file") {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
      return [{
        name: entry.name,
        path: absolutePath,
        type: isDatabase ? "database" : isDocument ? "document" : "file",
        ...symlink,
      } satisfies BrowseNode];
    }

    return [];
  });
}

export function getBrowseEntries(dir: string | null, showHidden = false) {
  let targetDir = dir || resolveWorkspaceRoot();
  if (!targetDir) {
    return {
      data: { currentDir: "/", entries: [], parentDir: null },
      status: 200 as const,
    };
  }

  if (targetDir.startsWith("~")) {
    targetDir = join(homedir(), targetDir.slice(1));
  }

  const resolvedDir = resolve(targetDir);
  return {
    data: {
      currentDir: resolvedDir,
      entries: buildBrowseTree(resolvedDir, 3, 0, showHidden),
      parentDir: resolvedDir === "/" ? null : dirname(resolvedDir),
    },
    status: 200 as const,
  };
}

export function getBrowseFile(path: string, raw = false) {
  if (!path) {
    return { error: "Missing 'path' query parameter", status: 400 as const };
  }
  const resolvedPath = resolveFilesystemPath(path);
  if (!resolvedPath || !existsSync(resolvedPath.absolutePath)) {
    return { error: "File not found", status: 404 as const };
  }
  try {
    const stats = statSync(resolvedPath.absolutePath);
    if (!stats.isFile()) {
      return { error: "Path is not a file", status: 400 as const };
    }
  } catch {
    return { error: "Cannot stat file", status: 500 as const };
  }

  if (raw) {
    try {
      const buffer = readFileSync(resolvedPath.absolutePath);
      const ext = resolvedPath.absolutePath.split(".").pop()?.toLowerCase() ?? "";
      return {
        buffer,
        contentType: BROWSE_FILE_MIME_MAP[ext] ?? "application/octet-stream",
        status: 200 as const,
      };
    } catch {
      return { error: "Cannot read file", status: 500 as const };
    }
  }

  try {
    const content = readFileSync(resolvedPath.absolutePath, "utf-8");
    const ext = resolvedPath.absolutePath.split(".").pop()?.toLowerCase();
    let type: "markdown" | "yaml" | "code" | "text" = "text";
    if (ext === "md" || ext === "mdx") type = "markdown";
    else if (ext === "yaml" || ext === "yml") type = "yaml";
    else if (CODE_EXTENSIONS.has(ext ?? "")) type = "code";
    return {
      data: { content, type },
      status: 200 as const,
    };
  } catch {
    return { error: "Cannot read file", status: 500 as const };
  }
}

export function createDirectory(path: string, absolute = false) {
  if (!path) {
    return { error: "Missing 'path' field", status: 400 as const };
  }
  const targetPath = absolute && !path.startsWith("/") && !path.startsWith("~/")
    ? resolveFilesystemPath(resolve(normalize(path)), { allowMissing: true })
    : resolveFilesystemPath(path, { allowMissing: true });
  if (!targetPath) {
    return { error: "Invalid path or path traversal rejected", status: 400 as const };
  }
  if (isProtectedSystemPath(targetPath)) {
    return { error: "Cannot create a protected system path", status: 403 as const };
  }
  if (existsSync(targetPath.absolutePath)) {
    return { error: "Directory already exists", status: 409 as const };
  }
  try {
    mkdirSync(targetPath.absolutePath, { recursive: true });
    return {
      data: {
        ok: true,
        path: targetPath.workspaceRelativePath ?? targetPath.absolutePath,
      },
      status: 200 as const,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "mkdir failed", status: 500 as const };
  }
}

export function movePath(sourcePath: string, destinationDir: string) {
  if (!sourcePath || !destinationDir) {
    return { error: "Missing 'sourcePath' and 'destinationDir' fields", status: 400 as const };
  }
  const sourceTarget = resolveFilesystemPath(sourcePath);
  if (isProtectedSystemPath(sourceTarget)) {
    return { error: "Cannot move system file", status: 403 as const };
  }
  if (!sourceTarget) {
    return { error: "Source not found or path traversal rejected", status: 404 as const };
  }
  const destinationDirTarget = resolveFilesystemPath(destinationDir);
  if (!destinationDirTarget) {
    return { error: "Destination not found or path traversal rejected", status: 404 as const };
  }
  if (!statSync(destinationDirTarget.absolutePath).isDirectory()) {
    return { error: "Destination is not a directory", status: 400 as const };
  }
  const srcAbsNorm = `${sourceTarget.absolutePath}/`;
  if (
    destinationDirTarget.absolutePath.startsWith(srcAbsNorm)
    || destinationDirTarget.absolutePath === sourceTarget.absolutePath
  ) {
    return { error: "Cannot move a folder into itself", status: 400 as const };
  }
  const itemName = basename(sourceTarget.absolutePath);
  const destAbs = join(destinationDirTarget.absolutePath, itemName);
  const destinationTarget = resolveFilesystemPath(destAbs, { allowMissing: true });
  if (!destinationTarget) {
    return { error: "Invalid destination path", status: 400 as const };
  }
  if (isProtectedSystemPath(destinationTarget)) {
    return { error: "Cannot move a file to a protected system path", status: 403 as const };
  }
  if (existsSync(destAbs)) {
    return { error: `'${itemName}' already exists in destination`, status: 409 as const };
  }
  try {
    renameSync(sourceTarget.absolutePath, destinationTarget.absolutePath);
    return {
      data: {
        ok: true,
        oldPath: sourcePath,
        newPath: destinationTarget.workspaceRelativePath ?? destinationTarget.absolutePath,
      },
      status: 200 as const,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Move failed", status: 500 as const };
  }
}

export function renamePath(path: string, newName: string) {
  if (!path || !newName) {
    return { error: "Missing 'path' and 'newName' fields", status: 400 as const };
  }
  const sourcePath = resolveFilesystemPath(path);
  if (isProtectedSystemPath(sourcePath)) {
    return { error: "Cannot rename system file", status: 403 as const };
  }
  if (newName.includes("/") || newName.includes("\\") || newName.trim() === "") {
    return { error: "Invalid file name", status: 400 as const };
  }
  if (!sourcePath) {
    return { error: "Source not found or path traversal rejected", status: 404 as const };
  }
  const parentDir = dirname(sourcePath.absolutePath);
  const newAbsPath = join(parentDir, newName);
  const destinationPath = resolveFilesystemPath(newAbsPath, { allowMissing: true });
  if (!destinationPath) {
    return { error: "Invalid destination path", status: 400 as const };
  }
  if (isProtectedSystemPath(destinationPath)) {
    return { error: "Cannot rename to a protected system file", status: 403 as const };
  }
  if (existsSync(newAbsPath)) {
    return { error: `A file named '${newName}' already exists`, status: 409 as const };
  }
  try {
    renameSync(sourcePath.absolutePath, destinationPath.absolutePath);
    return {
      data: {
        ok: true,
        oldPath: path,
        newPath: destinationPath.workspaceRelativePath ?? destinationPath.absolutePath,
      },
      status: 200 as const,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Rename failed", status: 500 as const };
  }
}

export function copyPath(path: string, destinationPath?: string) {
  if (!path) {
    return { error: "Missing 'path' field", status: 400 as const };
  }
  const sourceTarget = resolveFilesystemPath(path);
  if (isProtectedSystemPath(sourceTarget)) {
    return { error: "Cannot duplicate system file", status: 403 as const };
  }
  if (!sourceTarget) {
    return { error: "Source not found or path traversal rejected", status: 404 as const };
  }
  let destinationInputPath = destinationPath;
  if (!destinationInputPath) {
    const name = basename(sourceTarget.absolutePath);
    const dir = dirname(sourceTarget.absolutePath);
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const copyName = ext ? `${stem} copy${ext}` : `${stem} copy`;
    destinationInputPath = dir === "." ? copyName : `${dir}/${copyName}`;
  }
  const destinationTarget = resolveFilesystemPath(destinationInputPath, { allowMissing: true });
  if (!destinationTarget) {
    return { error: "Invalid destination path", status: 400 as const };
  }
  if (isProtectedSystemPath(destinationTarget)) {
    return { error: "Cannot duplicate to a protected system path", status: 403 as const };
  }
  if (existsSync(destinationTarget.absolutePath)) {
    return { error: "Destination already exists", status: 409 as const };
  }
  try {
    const isDir = statSync(sourceTarget.absolutePath).isDirectory();
    cpSync(sourceTarget.absolutePath, destinationTarget.absolutePath, { recursive: isDir });
    return {
      data: {
        ok: true,
        sourcePath: path,
        newPath: destinationTarget.workspaceRelativePath ?? destinationTarget.absolutePath,
      },
      status: 200 as const,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Copy failed", status: 500 as const };
  }
}
