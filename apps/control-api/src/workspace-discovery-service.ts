import type { Dirent } from "node:fs";
import {
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getRawFile,
  getWorkspaceFile,
  isProtectedSystemPath,
  resolveFilesystemPath,
  writeRawFile,
} from "./filesystem-service.js";
import {
  getActiveWorkspaceName,
  resolveOpenClawStateDir,
  resolveWorkspaceRoot,
} from "./workspace-service.js";

const execAsync = promisify(exec);
const TREE_SKIP_DIRS = new Set(["tmp", "exports", "node_modules", ".git", ".next"]);
const VIRTUAL_CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs",
  "java", "kt", "swift", "c", "cpp", "h", "hpp", "cs", "css", "scss",
  "less", "html", "htm", "xml", "json", "jsonc", "toml", "sh", "bash",
  "zsh", "fish", "ps1", "sql", "graphql", "gql", "diff", "patch",
  "ini", "env", "tf", "proto", "zig", "lua", "php",
]);
const WATCH_IGNORED = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /\.duckdb\.wal$/,
  /\.duckdb\.tmp$/,
];
const LINK_PREVIEW_FETCH_TIMEOUT_MS = 6000;
const LINK_PREVIEW_MAX_BODY_BYTES = 512_000;
const BROWSE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".Trash",
  "__pycache__",
  ".cache",
  ".DS_Store",
]);
const DB_EXTENSIONS = new Set(["duckdb", "sqlite", "sqlite3", "db", "postgres"]);

type ObjectRow = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  default_view?: string;
  display_field?: string;
};

type FieldRow = {
  id: string;
  name: string;
  type: string;
  sort_order?: number;
};

type DbObject = {
  name: string;
  icon?: string;
  default_view?: string;
};

type EavRow = {
  entry_id: string;
  created_at: string;
  updated_at: string;
  field_name: string;
  value: string | null;
};

export type TreeNode = {
  name: string;
  path: string;
  type: "object" | "document" | "folder" | "file" | "database" | "report" | "app";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
  virtual?: boolean;
  symlink?: boolean;
  appManifest?: {
    name: string;
    description?: string;
    icon?: string;
    version?: string;
    entry?: string;
    runtime?: string;
  };
};

export type WorkspaceContext = {
  exists: boolean;
  organization?: {
    id?: string;
    name?: string;
    slug?: string;
  };
  members?: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
  defaults?: {
    default_view?: string;
    date_format?: string;
    naming_convention?: string;
  };
};

export type SearchIndexItem = {
  id: string;
  label: string;
  sublabel?: string;
  kind: "file" | "object" | "entry";
  icon?: string;
  objectName?: string;
  entryId?: string;
  fields?: Record<string, string>;
  path?: string;
  nodeType?: "document" | "folder" | "file" | "report" | "database";
};

type SuggestItem = {
  name: string;
  path: string;
  type: "folder" | "file" | "document" | "database" | "object" | "entry";
  icon?: string;
  objectName?: string;
  entryId?: string;
};

export type LinkPreviewData = {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
  siteName?: string;
};

type TableInfo = {
  table_name: string;
  column_count: number;
  estimated_row_count: number;
  columns: Array<{
    name: string;
    type: string;
    is_nullable: boolean;
  }>;
};

type Listener = (type: string, relPath: string) => void;

let listeners = new Set<Listener>();
let sharedRoot: string | null = null;
let watcherReady = false;
let sharedWatcherPromise: Promise<unknown> | null = null;

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

export function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (line.trim().startsWith("#") || !line.trim()) continue;

    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (match) {
      currentListKey = null;
      const key = match[1];
      let value: unknown = match[2].trim();
      if (value === "") {
        currentListKey = key;
        result[key] = [];
        continue;
      }
      if (
        typeof value === "string" &&
        ((value.startsWith("\"") && value.endsWith("\""))
          || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (value === "null") value = null;
      else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        value = Number(value);
      }
      result[key] = value;
      continue;
    }

    if (currentListKey) {
      const listMatch = line.match(/^\s+-\s+(.*)/);
      if (listMatch) {
        let item: unknown = listMatch[1].trim();
        if (
          typeof item === "string" &&
          ((item.startsWith("\"") && item.endsWith("\""))
            || (item.startsWith("'") && item.endsWith("'")))
        ) {
          item = item.slice(1, -1);
        }
        (result[currentListKey] as unknown[]).push(item);
      } else {
        currentListKey = null;
      }
    }
  }

  return result;
}

export function isDatabaseFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? DB_EXTENSIONS.has(ext) : false;
}

function resolveDuckdbBin(): string | null {
  const home = homedir();
  const candidates = [
    join(home, ".duckdb", "cli", "latest", "duckdb"),
    join(home, ".local", "bin", "duckdb"),
    "/opt/homebrew/bin/duckdb",
    "/usr/local/bin/duckdb",
    "/usr/bin/duckdb",
  ];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }

  try {
    execSync("which duckdb", { encoding: "utf-8", timeout: 2000 });
    return "duckdb";
  } catch {
    return null;
  }
}

export function discoverDuckDBPaths(root?: string): string[] {
  const wsRoot = root ?? resolveWorkspaceRoot();
  if (!wsRoot) return [];

  const results: Array<{ path: string; depth: number }> = [];
  function walk(dir: string, depth: number) {
    const dbFile = join(dir, "workspace.duckdb");
    if (existsSync(dbFile)) {
      results.push({ path: dbFile, depth });
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || TREE_SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      }
    } catch {}
  }

  walk(wsRoot, 0);
  results.sort((a, b) => a.depth - b.depth);
  return results.map((item) => item.path);
}

async function duckdbQueryOnFileAsync<T = Record<string, unknown>>(
  dbFilePath: string,
  sql: string,
): Promise<T[]> {
  const bin = resolveDuckdbBin();
  if (!bin) return [];
  try {
    const escapedSql = sql.replace(/'/g, "'\\''");
    const { stdout } = await execAsync(`'${bin}' -json '${dbFilePath}' '${escapedSql}'`, {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/sh",
    });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "[]") return [];
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

async function duckdbQueryAsync<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const dbPaths = discoverDuckDBPaths();
  const db = dbPaths[0];
  if (!db) return [];
  return duckdbQueryOnFileAsync<T>(db, sql);
}

async function duckdbQueryAllAsync<T = Record<string, unknown>>(
  sql: string,
  dedupeKey?: keyof T,
): Promise<T[]> {
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) return [];
  const seen = new Set<unknown>();
  const merged: T[] = [];
  for (const db of dbPaths) {
    const rows = await duckdbQueryOnFileAsync<T>(db, sql);
    for (const row of rows) {
      if (dedupeKey) {
        const key = row[dedupeKey];
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(row);
    }
  }
  return merged;
}

function dbStr(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function resolveDisplayField(obj: ObjectRow, fields: FieldRow[]): string {
  if (obj.display_field) return obj.display_field;
  const nameField = fields.find((f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name));
  if (nameField) return nameField.name;
  const textField = fields.find((f) => f.type === "text");
  if (textField) return textField.name;
  return fields[0]?.name ?? "id";
}

async function loadDbObjects(): Promise<Map<string, DbObject>> {
  const map = new Map<string, DbObject>();
  const rows = await duckdbQueryAllAsync<DbObject & { name: string }>(
    "SELECT name, icon, default_view FROM objects",
    "name",
  );
  for (const row of rows) {
    map.set(row.name, row);
  }
  return map;
}

async function resolveEntryType(
  entry: Dirent,
  absPath: string,
): Promise<"directory" | "file" | null> {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) {
    try {
      const st = statSync(absPath);
      if (st.isDirectory()) return "directory";
      if (st.isFile()) return "file";
    } catch {}
  }
  return null;
}

async function readObjectMeta(
  dirPath: string,
): Promise<{ icon?: string; defaultView?: string } | null> {
  const yamlPath = join(dirPath, ".object.yaml");
  if (!pathExists(yamlPath)) return null;
  try {
    const content = readFileSync(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      icon: parsed.icon as string | undefined,
      defaultView: parsed.default_view as string | undefined,
    };
  } catch {
    return null;
  }
}

async function readAppManifest(dirPath: string): Promise<TreeNode["appManifest"] | null> {
  const yamlPath = join(dirPath, ".dench.yaml");
  if (!pathExists(yamlPath)) return null;
  try {
    const content = readFileSync(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      name: (parsed.name as string) || dirPath.split("/").pop()?.replace(/\.dench\.app$/, "") || "App",
      description: parsed.description as string | undefined,
      icon: parsed.icon as string | undefined,
      version: parsed.version as string | undefined,
      entry: (parsed.entry as string) || "index.html",
      runtime: (parsed.runtime as string) || "static",
    };
  } catch {
    return null;
  }
}

function parseSkillFrontmatter(content: string): { name?: string; emoji?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
    if (kv) result[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { name: result.name, emoji: result.emoji };
}

function resolveUrl(relativeValue: string, base: string): string | undefined {
  try {
    return new URL(relativeValue, base).toString();
  } catch {
    return undefined;
  }
}

function extractMetaContent(html: string, nameOrProperty: string): string | undefined {
  const escaped = nameOrProperty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta\\s+[^>]*(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*?)["'][^>]*>`
      + `|<meta\\s+[^>]*content\\s*=\\s*["']([^"']*?)["'][^>]*(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*>`,
    "i",
  );
  const match = html.match(re);
  const value = match?.[1] ?? match?.[2];
  return value?.trim() || undefined;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

function extractFaviconHref(html: string): string | undefined {
  const iconMatch = html.match(
    /<link\s+[^>]*rel\s*=\s*["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href\s*=\s*["']([^"']+?)["'][^>]*>/i,
  ) ?? html.match(
    /<link\s+[^>]*href\s*=\s*["']([^"']+?)["'][^>]*rel\s*=\s*["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>/i,
  );
  return iconMatch?.[1]?.trim() || undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseLinkPreviewMetadata(html: string, pageUrl: string): LinkPreviewData {
  const parsedUrl = new URL(pageUrl);
  const domain = parsedUrl.hostname;
  const ogTitle = extractMetaContent(html, "og:title");
  const twitterTitle = extractMetaContent(html, "twitter:title");
  const htmlTitle = extractTitle(html);
  const ogDescription = extractMetaContent(html, "og:description");
  const twitterDescription = extractMetaContent(html, "twitter:description");
  const metaDescription = extractMetaContent(html, "description");
  const ogImage = extractMetaContent(html, "og:image");
  const twitterImage = extractMetaContent(html, "twitter:image");
  const twitterImageSrc = extractMetaContent(html, "twitter:image:src");
  const ogSiteName = extractMetaContent(html, "og:site_name");
  const rawFavicon = extractFaviconHref(html);
  const rawTitle = ogTitle ?? twitterTitle ?? htmlTitle;
  const rawDescription = ogDescription ?? twitterDescription ?? metaDescription;
  const rawImage = ogImage ?? twitterImage ?? twitterImageSrc;
  const result: LinkPreviewData = { url: pageUrl, domain };
  if (rawTitle) result.title = decodeEntities(rawTitle);
  if (rawDescription) result.description = decodeEntities(rawDescription);
  if (rawImage) result.imageUrl = resolveUrl(rawImage, pageUrl);
  if (ogSiteName) result.siteName = decodeEntities(ogSiteName);
  result.faviconUrl = rawFavicon
    ? resolveUrl(rawFavicon, pageUrl)
    : `${parsedUrl.protocol}//${parsedUrl.host}/favicon.ico`;
  return result;
}

async function buildSkillsVirtualFolder(): Promise<TreeNode | null> {
  const workspaceRoot = resolveWorkspaceRoot();
  if (!workspaceRoot) return null;
  const dir = join(workspaceRoot, "skills");
  const children: TreeNode[] = [];
  const seen = new Set<string>();

  if (!pathExists(dir)) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      if (entry.name === "crm" || entry.name === "browser") continue;
      const skillMdPath = join(dir, entry.name, "SKILL.md");
      if (!pathExists(skillMdPath)) continue;
      seen.add(entry.name);
      let displayName = entry.name;
      try {
        const content = readFileSync(skillMdPath, "utf-8");
        const meta = parseSkillFrontmatter(content);
        if (meta.name) displayName = meta.name;
        if (meta.emoji) displayName = `${meta.emoji} ${displayName}`;
      } catch {}
      children.push({
        name: displayName,
        path: `~skills/${entry.name}/SKILL.md`,
        type: "document",
        virtual: true,
      });
    }
  } catch {}

  if (children.length === 0) return null;
  children.sort((a, b) => a.name.localeCompare(b.name));
  return {
    name: "Skills",
    path: "~skills",
    type: "folder",
    virtual: true,
    children,
  };
}

async function buildTree(
  absDir: string,
  relativeBase: string,
  dbObjects: Map<string, DbObject>,
  showHidden = false,
): Promise<TreeNode[]> {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const filtered = entries.filter((entry) => {
    if (entry.name === ".object.yaml") return true;
    if (entry.name.startsWith(".")) return showHidden;
    return true;
  });

  const typedEntries = await Promise.all(filtered.map(async (entry) => {
    const absPath = join(absDir, entry.name);
    const effectiveType = await resolveEntryType(entry, absPath);
    return { entry, absPath, effectiveType };
  }));

  const sorted = typedEntries.toSorted((a, b) => {
    const dirA = a.effectiveType === "directory";
    const dirB = b.effectiveType === "directory";
    if (dirA && !dirB) return -1;
    if (!dirA && dirB) return 1;
    return a.entry.name.localeCompare(b.entry.name);
  });

  const nodes: TreeNode[] = [];
  for (const { entry, absPath, effectiveType } of sorted) {
    if (entry.name === ".object.yaml" && !showHidden) continue;
    const relPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const isSymlink = entry.isSymbolicLink();

    if (effectiveType === "directory") {
      if (entry.name.endsWith(".dench.app")) {
        const manifest = await readAppManifest(absPath);
        const displayName = manifest?.name || entry.name.replace(/\.dench\.app$/, "");
        const children = showHidden ? await buildTree(absPath, relPath, dbObjects, showHidden) : undefined;
        nodes.push({
          name: displayName,
          path: relPath,
          type: "app",
          icon: manifest?.icon,
          appManifest: manifest ?? { name: displayName, entry: "index.html", runtime: "static" },
          ...(children && children.length > 0 && { children }),
          ...(isSymlink && { symlink: true }),
        });
        continue;
      }

      const objectMeta = await readObjectMeta(absPath);
      const dbObject = dbObjects.get(entry.name);
      const children = await buildTree(absPath, relPath, dbObjects, showHidden);
      if (objectMeta || dbObject) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "object",
          icon: objectMeta?.icon ?? dbObject?.icon,
          defaultView: ((objectMeta?.defaultView ?? dbObject?.default_view) as "table" | "kanban") ?? "table",
          children: children.length > 0 ? children : undefined,
          ...(isSymlink && { symlink: true }),
        });
      } else {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "folder",
          children: children.length > 0 ? children : undefined,
          ...(isSymlink && { symlink: true }),
        });
      }
    } else if (effectiveType === "file") {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isReport = entry.name.endsWith(".report.json");
      const isDocument = ext === "md" || ext === "mdx";
      const isDb = isDatabaseFile(entry.name);
      nodes.push({
        name: entry.name,
        path: relPath,
        type: isReport ? "report" : isDb ? "database" : isDocument ? "document" : "file",
        ...(isSymlink && { symlink: true }),
      });
    }
  }

  return nodes;
}

export async function getWorkspaceTree(showHidden = false) {
  const openclawDir = resolveOpenClawStateDir();
  const workspace = getActiveWorkspaceName();
  const root = resolveWorkspaceRoot();
  if (!root) {
    const tree: TreeNode[] = [];
    const skillsFolder = await buildSkillsVirtualFolder();
    if (skillsFolder) tree.push(skillsFolder);
    return { tree, exists: false, workspaceRoot: null, openclawDir, workspace };
  }

  const dbObjects = await loadDbObjects();
  const tree = await buildTree(root, "", dbObjects, showHidden);
  const skillsFolder = await buildSkillsVirtualFolder();
  if (skillsFolder) tree.push(skillsFolder);
  return { tree, exists: true, workspaceRoot: root, openclawDir, workspace };
}

function parseWorkspaceContextContent(content: string): WorkspaceContext {
  const ctx: WorkspaceContext = { exists: true };
  const orgMatch = content.match(/organization:\s*\n((?:\s{2,}.+\n)*)/);
  if (orgMatch) {
    const orgBlock = orgMatch[1];
    const org: Record<string, string> = {};
    for (const line of orgBlock.split("\n")) {
      const kv = line.match(/^\s+(\w+)\s*:\s*"?([^"\n]+)"?/);
      if (kv) org[kv[1]] = kv[2].trim();
    }
    ctx.organization = { id: org.id, name: org.name, slug: org.slug };
  }
  const membersMatch = content.match(/members:\s*\n((?:\s{2,}.+\n)*)/);
  if (membersMatch) {
    const membersBlock = membersMatch[1];
    const members: WorkspaceContext["members"] = [];
    let current: Record<string, string> = {};
    for (const line of membersBlock.split("\n")) {
      const itemStart = line.match(/^\s+-\s+(\w+)\s*:\s*"?([^"\n]+)"?/);
      const propLine = line.match(/^\s+(\w+)\s*:\s*"?([^"\n]+)"?/);
      if (itemStart) {
        if (current.id) members.push(current as never);
        current = { [itemStart[1]]: itemStart[2].trim() };
      } else if (propLine && !line.trim().startsWith("-")) {
        current[propLine[1]] = propLine[2].trim();
      }
    }
    if (current.id) members.push(current as never);
    ctx.members = members;
  }
  const defaultsMatch = content.match(/defaults:\s*\n((?:\s{2,}.+\n)*)/);
  if (defaultsMatch) {
    const defaultsBlock = defaultsMatch[1];
    const defaults: Record<string, string> = {};
    for (const line of defaultsBlock.split("\n")) {
      const kv = line.match(/^\s+(\w[\w_]*)\s*:\s*(.+)/);
      if (kv) defaults[kv[1]] = kv[2].trim();
    }
    ctx.defaults = {
      default_view: defaults.default_view,
      date_format: defaults.date_format,
      naming_convention: defaults.naming_convention,
    };
  }
  return ctx;
}

export function getWorkspaceContext(): WorkspaceContext {
  const root = resolveWorkspaceRoot();
  if (!root) {
    return { exists: false };
  }
  const ctxPath = join(root, "workspace_context.yaml");
  if (!existsSync(ctxPath)) {
    return { exists: true };
  }
  try {
    return parseWorkspaceContextContent(readFileSync(ctxPath, "utf-8"));
  } catch {
    return { exists: true };
  }
}

function flattenTree(
  absDir: string,
  relBase: string,
  dbObjects: Map<string, ObjectRow>,
  items: SearchIndexItem[],
) {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absPath = join(absDir, entry.name);
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const dbObj = dbObjects.get(entry.name);
      const yamlPath = join(absPath, ".object.yaml");
      const hasYaml = existsSync(yamlPath);
      if (dbObj || hasYaml) {
        let icon: string | undefined;
        if (hasYaml) {
          try {
            const parsed = parseSimpleYaml(readFileSync(yamlPath, "utf-8"));
            icon = parsed.icon as string | undefined;
          } catch {}
        }
        items.push({
          id: relPath,
          label: entry.name,
          sublabel: relPath,
          kind: "object",
          icon: icon ?? dbObj?.icon,
          path: relPath,
        });
      }
      flattenTree(absPath, relPath, dbObjects, items);
    } else if (entry.isFile()) {
      const isReport = entry.name.endsWith(".report.json");
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDb = isDatabaseFile(entry.name);
      items.push({
        id: relPath,
        label: entry.name.replace(/\.md$/, ""),
        sublabel: relPath,
        kind: "file",
        path: relPath,
        nodeType: isReport ? "report" : isDb ? "database" : isDocument ? "document" : "file",
      });
    }
  }
}

async function buildEntryItems(): Promise<SearchIndexItem[]> {
  const items: SearchIndexItem[] = [];
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) return [];

  const seenNames = new Set<string>();
  const objectsWithDb: Array<{ obj: ObjectRow; dbPath: string }> = [];
  for (const dbPath of dbPaths) {
    const objs = await duckdbQueryOnFileAsync<ObjectRow>(dbPath, "SELECT * FROM objects ORDER BY name");
    for (const obj of objs) {
      if (seenNames.has(obj.name)) continue;
      seenNames.add(obj.name);
      objectsWithDb.push({ obj, dbPath });
    }
  }

  for (const { obj, dbPath } of objectsWithDb) {
    const fields = await duckdbQueryOnFileAsync<FieldRow>(
      dbPath,
      `SELECT * FROM fields WHERE object_id = '${sqlEscape(obj.id)}' ORDER BY sort_order`,
    );
    const displayField = resolveDisplayField(obj, fields);
    const previewFields = fields.filter((f) => !["relation", "richtext"].includes(f.type)).slice(0, 4);
    let entries: Record<string, unknown>[] = await duckdbQueryOnFileAsync(
      dbPath,
      `SELECT * FROM v_${obj.name} ORDER BY created_at DESC LIMIT 500`,
    );
    if (entries.length === 0) {
      const rawRows = await duckdbQueryOnFileAsync<EavRow>(
        dbPath,
        `SELECT e.id as entry_id, e.created_at, e.updated_at,
                f.name as field_name, ef.value
         FROM entries e
         JOIN entry_fields ef ON ef.entry_id = e.id
         JOIN fields f ON f.id = ef.field_id
         WHERE e.object_id = '${sqlEscape(obj.id)}'
         ORDER BY e.created_at DESC
         LIMIT 2500`,
      );
      const grouped = new Map<string, Record<string, unknown>>();
      for (const row of rawRows) {
        let entry = grouped.get(row.entry_id);
        if (!entry) {
          entry = { entry_id: row.entry_id };
          grouped.set(row.entry_id, entry);
        }
        if (row.field_name) entry[row.field_name] = row.value;
      }
      entries = Array.from(grouped.values());
    }
    for (const entry of entries) {
      const entryId = dbStr(entry.entry_id);
      if (!entryId) continue;
      const displayValue = dbStr(entry[displayField]);
      const fieldPreview: Record<string, string> = {};
      for (const f of previewFields) {
        const val = entry[f.name];
        if (val != null && val !== "") fieldPreview[f.name] = dbStr(val);
      }
      items.push({
        id: `entry:${obj.name}:${entryId}`,
        label: displayValue || `(${obj.name} entry)`,
        sublabel: obj.name,
        kind: "entry",
        icon: obj.icon,
        objectName: obj.name,
        entryId,
        fields: Object.keys(fieldPreview).length > 0 ? fieldPreview : undefined,
      });
    }
  }
  return items;
}

export async function getWorkspaceSearchIndex() {
  const items: SearchIndexItem[] = [];
  const root = resolveWorkspaceRoot();
  if (root) {
    const dbObjects = new Map<string, ObjectRow>();
    const objs = await duckdbQueryAllAsync<ObjectRow & { name: string }>("SELECT * FROM objects", "name");
    for (const obj of objs) dbObjects.set(obj.name, obj);
    flattenTree(root, "", dbObjects, items);
  }
  if (discoverDuckDBPaths().length > 0) {
    items.push(...await buildEntryItems());
  }
  return { items };
}

function listDir(absDir: string, filter?: string): SuggestItem[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const lowerFilter = filter?.toLowerCase();
  const sorted = entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !(entry.isDirectory() && BROWSE_SKIP_DIRS.has(entry.name)))
    .filter((entry) => !lowerFilter || entry.name.toLowerCase().includes(lowerFilter))
    .toSorted((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
  const items: SuggestItem[] = [];
  for (const entry of sorted) {
    if (items.length >= 30) break;
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      items.push({ name: entry.name, path: absPath, type: "folder" });
    } else if (entry.isFile()) {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDb = ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
      items.push({
        name: entry.name,
        path: absPath,
        type: isDb ? "database" : isDocument ? "document" : "file",
      });
    }
  }
  return items;
}

function searchFiles(absDir: string, query: string, results: SuggestItem[], maxResults: number, depth = 0): void {
  if (depth > 6 || results.length >= maxResults) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  const lowerQuery = query.toLowerCase();
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && BROWSE_SKIP_DIRS.has(entry.name)) continue;
    const absPath = join(absDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().includes(lowerQuery)) {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDb = ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
      results.push({
        name: entry.name,
        path: absPath,
        type: isDb ? "database" : isDocument ? "document" : "file",
      });
    } else if (entry.isDirectory() && entry.name.toLowerCase().includes(lowerQuery)) {
      results.push({ name: entry.name, path: absPath, type: "folder" });
    }
    if (entry.isDirectory()) {
      searchFiles(absPath, query, results, maxResults, depth + 1);
    }
  }
}

function resolvePathQuery(raw: string, workspaceRoot: string): { dir: string; filter?: string } | null {
  const home = homedir();
  if (raw.startsWith("~/")) {
    const rest = raw.slice(2);
    if (!rest || rest.endsWith("/")) return { dir: rest ? resolve(home, rest) : home };
    return { dir: resolve(home, dirname(rest)), filter: basename(rest) };
  }
  if (raw.startsWith("/")) {
    if (raw === "/") return { dir: "/" };
    if (raw.endsWith("/")) return { dir: resolve(raw) };
    return { dir: dirname(resolve(raw)), filter: basename(raw) };
  }
  if (raw.startsWith("../") || raw === "..") {
    const resolved = resolve(workspaceRoot, raw);
    if (raw.endsWith("/") || raw === "..") return { dir: resolved };
    return { dir: dirname(resolved), filter: basename(resolved) };
  }
  if (raw.startsWith("./")) {
    const rest = raw.slice(2);
    if (!rest || rest.endsWith("/")) return { dir: rest ? resolve(workspaceRoot, rest) : workspaceRoot };
    return { dir: resolve(workspaceRoot, dirname(rest)), filter: basename(rest) };
  }
  if (raw.includes("/")) {
    if (raw.endsWith("/")) return { dir: resolve(workspaceRoot, raw) };
    return { dir: resolve(workspaceRoot, dirname(raw)), filter: basename(raw) };
  }
  return null;
}

function readObjectIcon(workspaceRoot: string, objName: string): string | undefined {
  function walk(dir: string, depth: number): string | undefined {
    if (depth > 4) return undefined;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (entry.name === objName) {
          const yamlPath = join(dir, entry.name, ".object.yaml");
          if (existsSync(yamlPath)) {
            const parsed = parseSimpleYaml(readFileSync(yamlPath, "utf-8"));
            if (parsed.icon) return dbStr(parsed.icon);
          }
        }
        const found = walk(join(dir, entry.name), depth + 1);
        if (found) return found;
      }
    } catch {}
    return undefined;
  }
  return walk(workspaceRoot, 0);
}

async function searchObjects(query: string, workspaceRoot: string, max: number): Promise<SuggestItem[]> {
  const sql = query
    ? `SELECT * FROM objects WHERE LOWER(name) LIKE LOWER('%${sqlEscape(query)}%') ORDER BY name LIMIT ${max}`
    : `SELECT * FROM objects ORDER BY name LIMIT ${max}`;
  const objects = await duckdbQueryAllAsync<ObjectRow>(sql, "name");
  return objects.map((obj) => ({
    name: obj.name,
    path: `workspace:object:${obj.name}`,
    type: "object",
    icon: readObjectIcon(workspaceRoot, obj.name) ?? obj.icon,
  }));
}

async function searchEntries(query: string, max: number): Promise<SuggestItem[]> {
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0 || !query) return [];

  const items: SuggestItem[] = [];
  const seenObjects = new Set<string>();
  const likePattern = `%${sqlEscape(query)}%`;

  for (const dbPath of dbPaths) {
    if (items.length >= max) break;
    type ObjFieldRow = ObjectRow & { field_name: string; field_type: string };
    const objFields = await duckdbQueryOnFileAsync<ObjFieldRow>(
      dbPath,
      `SELECT o.*, f.name as field_name, f.type as field_type
       FROM objects o
       LEFT JOIN fields f ON f.object_id = o.id
       ORDER BY o.name, f.sort_order`,
    );
    const objectMap = new Map<string, { obj: ObjectRow; displayField: string }>();
    const fieldsByObj = new Map<string, FieldRow[]>();
    for (const row of objFields) {
      if (seenObjects.has(row.name)) continue;
      if (!fieldsByObj.has(row.id)) fieldsByObj.set(row.id, []);
      if (row.field_name) {
        fieldsByObj.get(row.id)?.push({ id: row.id, name: row.field_name, type: row.field_type });
      }
      if (!objectMap.has(row.name)) {
        const fields = fieldsByObj.get(row.id) ?? [];
        objectMap.set(row.name, { obj: row, displayField: resolveDisplayField(row, fields) });
      }
    }
    for (const [name, entry] of objectMap) {
      const fields = fieldsByObj.get(entry.obj.id) ?? [];
      entry.displayField = resolveDisplayField(entry.obj, fields);
      seenObjects.add(name);
    }
    if (objectMap.size === 0) continue;
    const unionParts: string[] = [];
    for (const [name, { displayField }] of objectMap) {
      const safeDisplay = sqlEscape(displayField);
      unionParts.push(
        `(SELECT '${sqlEscape(name)}' as _obj_name, entry_id, "${safeDisplay}" as _display
          FROM v_${name}
          WHERE LOWER(CAST("${safeDisplay}" AS VARCHAR)) LIKE LOWER('${likePattern}')
          LIMIT ${max})`,
      );
    }
    if (unionParts.length === 0) continue;
    type EntryHit = { _obj_name: string; entry_id: string; _display: string };
    const hits = await duckdbQueryOnFileAsync<EntryHit>(dbPath, `${unionParts.join(" UNION ALL ")} LIMIT ${max}`);
    for (const hit of hits) {
      if (items.length >= max) return items;
      if (!hit.entry_id || !hit._display) continue;
      const objInfo = objectMap.get(hit._obj_name);
      items.push({
        name: String(hit._display),
        path: `workspace:entry:${hit._obj_name}:${hit.entry_id}`,
        type: "entry",
        icon: objInfo?.obj.icon,
        objectName: hit._obj_name,
        entryId: hit.entry_id,
      });
    }
  }
  return items;
}

export async function getSuggestedFiles(pathQuery: string | null, searchQuery: string | null) {
  const workspaceRoot = resolveWorkspaceRoot() ?? homedir();
  if (searchQuery) {
    const fileResults: SuggestItem[] = [];
    searchFiles(workspaceRoot, searchQuery, fileResults, 15);
    const objectResults = await searchObjects(searchQuery, workspaceRoot, 10);
    const entryResults = await searchEntries(searchQuery, 15);
    const objectNames = new Set(objectResults.map((item) => item.name));
    const dedupedFiles = fileResults.filter((item) => !(item.type === "folder" && objectNames.has(item.name)));
    return { items: [...objectResults, ...entryResults, ...dedupedFiles].slice(0, 30) };
  }
  if (pathQuery) {
    const resolved = resolvePathQuery(pathQuery, workspaceRoot);
    if (!resolved) {
      const results: SuggestItem[] = [];
      searchFiles(workspaceRoot, pathQuery, results, 20);
      return { items: results };
    }
    return { items: listDir(resolved.dir, resolved.filter) };
  }
  const fileItems = listDir(workspaceRoot);
  const objectItems = await searchObjects("", workspaceRoot, 20);
  const objectNames = new Set(objectItems.map((item) => item.name));
  const dedupedFiles = fileItems.filter((item) => !(item.type === "folder" && objectNames.has(item.name)));
  return { items: [...objectItems, ...dedupedFiles] };
}

export type FilterValue =
  | { type: "dateRange"; from?: string; to?: string }
  | { type: "select"; value?: string }
  | { type: "multiSelect"; values?: string[] }
  | { type: "number"; min?: number; max?: number };

export type FilterEntry = {
  id: string;
  column: string;
  value: FilterValue;
};

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildFilterClauses(filters?: FilterEntry[]): string[] {
  if (!filters || filters.length === 0) return [];
  const clauses: string[] = [];
  for (const filter of filters) {
    const column = `"${filter.column.replace(/"/g, "\"\"")}"`;
    const value = filter.value;
    if (value.type === "dateRange") {
      if (value.from) clauses.push(`${column} >= '${escapeSqlString(value.from)}'`);
      if (value.to) clauses.push(`${column} <= '${escapeSqlString(value.to)}'`);
    } else if (value.type === "select" && value.value) {
      clauses.push(`${column} = '${escapeSqlString(value.value)}'`);
    } else if (value.type === "multiSelect" && value.values && value.values.length > 0) {
      clauses.push(`${column} IN (${value.values.map((item) => `'${escapeSqlString(item)}'`).join(", ")})`);
    } else if (value.type === "number") {
      if (value.min !== undefined) clauses.push(`CAST(${column} AS NUMERIC) >= ${Number(value.min)}`);
      if (value.max !== undefined) clauses.push(`CAST(${column} AS NUMERIC) <= ${Number(value.max)}`);
    }
  }
  return clauses;
}

function injectFilters(sql: string, filterClauses: string[]): string {
  if (filterClauses.length === 0) return sql;
  return `WITH __report_data AS (${sql.replace(/;$/, "")}) SELECT * FROM __report_data WHERE ${filterClauses.join(" AND ")}`;
}

function checkReportSqlSafety(sql: string): string | null {
  const upper = sql.toUpperCase().trim();
  for (const keyword of ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "TRUNCATE"]) {
    if (upper.startsWith(keyword)) return "Only SELECT queries are allowed in reports";
  }
  return null;
}

export async function runWorkspaceQuery(sql: string) {
  if (!sql || typeof sql !== "string") {
    return { error: "Missing 'sql' field in request body", status: 400 as const };
  }
  const upper = sql.toUpperCase().trim();
  if (
    upper.startsWith("DROP")
    || upper.startsWith("DELETE")
    || upper.startsWith("INSERT")
    || upper.startsWith("UPDATE")
    || upper.startsWith("ALTER")
    || upper.startsWith("CREATE")
  ) {
    return { error: "Only SELECT queries are allowed", status: 403 as const };
  }
  return { data: { rows: await duckdbQueryAsync(sql) }, status: 200 as const };
}

export async function executeWorkspaceReport(sql: string, filters?: FilterEntry[]) {
  if (!sql || typeof sql !== "string") {
    return { error: "Missing 'sql' field in request body", status: 400 as const };
  }
  const safetyError = checkReportSqlSafety(sql);
  if (safetyError) {
    return { error: safetyError, status: 403 as const };
  }
  const finalSql = injectFilters(sql, buildFilterClauses(filters));
  try {
    return {
      data: {
        rows: await duckdbQueryAsync(finalSql),
        sql: finalSql,
      },
      status: 200 as const,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Query execution failed", status: 500 as const };
  }
}

const BLOCKED_PATTERN = /^\s*(DROP\s+DATABASE|ATTACH|DETACH|COPY|EXPORT|INSTALL|LOAD|PRAGMA|\.)/i;

export async function executeWorkspaceSql(sql: string) {
  if (!sql || typeof sql !== "string") {
    return { error: "Missing 'sql' field in request body", status: 400 as const };
  }
  if (BLOCKED_PATTERN.test(sql)) {
    return { error: "This SQL statement is not allowed", status: 403 as const };
  }
  try {
    return { data: { rows: await duckdbQueryAsync(sql), ok: true }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Query failed", status: 500 as const };
  }
}

export async function introspectDatabase(path: string) {
  if (!path) {
    return { error: "Missing required `path` query parameter", status: 400 as const };
  }
  const resolved = resolveFilesystemPath(path);
  const absPath = resolved?.withinWorkspace ? resolved.absolutePath : null;
  if (!absPath) {
    return { error: "File not found or path traversal rejected", status: 404 as const };
  }
  if (!resolveDuckdbBin()) {
    return { data: { tables: [], path, duckdb_available: false }, status: 200 as const };
  }
  const rawTables = await duckdbQueryOnFileAsync<{ table_name: string; table_type: string }>(
    absPath,
    "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
  );
  if (rawTables.length === 0) {
    return { data: { tables: [], path }, status: 200 as const };
  }
  const tables: TableInfo[] = [];
  for (const table of rawTables) {
    const cols = await duckdbQueryOnFileAsync<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      absPath,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'main' AND table_name = '${table.table_name.replace(/'/g, "''")}' ORDER BY ordinal_position`,
    );
    let rowCount = 0;
    try {
      const countResult = await duckdbQueryOnFileAsync<{ cnt: number }>(
        absPath,
        `SELECT count(*) as cnt FROM "${table.table_name.replace(/"/g, "\"\"")}"`,
      );
      rowCount = countResult[0]?.cnt ?? 0;
    } catch {}
    tables.push({
      table_name: table.table_name,
      column_count: cols.length,
      estimated_row_count: rowCount,
      columns: cols.map((column) => ({
        name: column.column_name,
        type: column.data_type,
        is_nullable: column.is_nullable === "YES",
      })),
    });
  }
  return { data: { tables, path }, status: 200 as const };
}

export async function queryDatabaseFile(path: string, sql: string) {
  if (!path || !sql) {
    return { error: "Missing required `path` and `sql` fields", status: 400 as const };
  }
  const trimmedSql = sql.trim().toUpperCase();
  if (
    !trimmedSql.startsWith("SELECT")
    && !trimmedSql.startsWith("PRAGMA")
    && !trimmedSql.startsWith("DESCRIBE")
    && !trimmedSql.startsWith("SHOW")
    && !trimmedSql.startsWith("EXPLAIN")
    && !trimmedSql.startsWith("WITH")
  ) {
    return { error: "Only read-only queries (SELECT, DESCRIBE, SHOW, EXPLAIN, WITH) are allowed", status: 403 as const };
  }
  const resolved = resolveFilesystemPath(path);
  const absPath = resolved?.withinWorkspace ? resolved.absolutePath : null;
  if (!absPath) {
    return { error: "File not found or path traversal rejected", status: 404 as const };
  }
  return {
    data: {
      rows: await duckdbQueryOnFileAsync(absPath, sql),
      sql,
    },
    status: 200 as const,
  };
}

export async function writeBinaryFile(formData: FormData) {
  const file = formData.get("file");
  const path = formData.get("path");
  if (!path || typeof path !== "string") {
    return { error: "Missing 'path' field", status: 400 as const };
  }
  if (!(file instanceof Blob)) {
    return { error: "Missing 'file' field (Blob)", status: 400 as const };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return writeRawFile(path, buffer);
}

function resolveVirtualPath(virtualPath: string): string | null {
  const workspaceDir = resolveWorkspaceRoot();
  if (!workspaceDir) return null;
  if (virtualPath.startsWith("~skills/")) {
    const rest = virtualPath.slice("~skills/".length);
    const parts = rest.split("/");
    if (parts.length !== 2 || parts[1] !== "SKILL.md" || !parts[0]) return null;
    const skillName = parts[0];
    if (skillName.includes("..") || skillName.includes("/")) return null;
    return join(workspaceDir, "skills", skillName, "SKILL.md");
  }
  if (virtualPath.startsWith("~memories/")) {
    const rest = virtualPath.slice("~memories/".length);
    if (rest.includes("..") || rest.includes("/")) return null;
    if (rest === "MEMORY.md") {
      for (const filename of ["MEMORY.md", "memory.md"]) {
        const candidate = join(workspaceDir, filename);
        if (existsSync(candidate)) return candidate;
      }
      return join(workspaceDir, "MEMORY.md");
    }
    if (!rest.endsWith(".md")) return null;
    return join(workspaceDir, "memory", rest);
  }
  if (virtualPath.startsWith("~workspace/")) {
    const rest = virtualPath.slice("~workspace/".length);
    if (!rest || rest.includes("..") || rest.includes("/")) return null;
    return join(workspaceDir, rest);
  }
  return null;
}

function isSafeVirtualPath(absPath: string): boolean {
  const workspaceDir = resolveWorkspaceRoot();
  if (!workspaceDir) return false;
  const normalized = normalize(resolve(absPath));
  const allowed = [normalize(join(workspaceDir, "skills")), normalize(workspaceDir)];
  return allowed.some((dir) => normalized.startsWith(dir));
}

export function getVirtualFile(path: string) {
  if (!path) return { error: "Missing 'path' query parameter", status: 400 as const };
  const absPath = resolveVirtualPath(path);
  if (!absPath || !isSafeVirtualPath(absPath)) {
    return { error: "Invalid virtual path", status: 400 as const };
  }
  if (!existsSync(absPath)) {
    return { error: "File not found", status: 404 as const };
  }
  try {
    const content = readFileSync(absPath, "utf-8");
    const ext = absPath.split(".").pop()?.toLowerCase();
    let type: "markdown" | "yaml" | "code" | "text" = "text";
    if (ext === "md" || ext === "mdx") type = "markdown";
    else if (ext === "yaml" || ext === "yml") type = "yaml";
    else if (VIRTUAL_CODE_EXTENSIONS.has(ext ?? "")) type = "code";
    return { data: { content, type }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Read failed", status: 500 as const };
  }
}

export function writeVirtualFile(path: string, content: string) {
  if (!path || typeof content !== "string") {
    return { error: "Missing 'path' and 'content' fields", status: 400 as const };
  }
  const absPath = resolveVirtualPath(path);
  if (!absPath || !isSafeVirtualPath(absPath)) {
    return { error: "Invalid virtual path", status: 400 as const };
  }
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    return { data: { ok: true, path }, status: 200 as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Write failed", status: 500 as const };
  }
}

function expandUserPath(inputPath: string): string {
  return inputPath.startsWith("~/") ? inputPath.replace(/^~/, homedir()) : inputPath;
}

export async function getPathInfo(path: string) {
  if (!path) {
    return { error: "Missing 'path' query parameter", status: 400 as const };
  }
  let candidatePath = path;
  if (candidatePath.startsWith("file://")) {
    try {
      candidatePath = fileURLToPath(candidatePath);
    } catch {
      return { error: "Invalid file URL", status: 400 as const };
    }
  }
  const expandedPath = expandUserPath(candidatePath);
  let resolvedPath = resolve(normalize(expandedPath));
  if (!existsSync(resolvedPath) && !path.includes("/")) {
    const found = await new Promise<string | null>((res) => {
      exec(`mdfind -name ${JSON.stringify(path)} | head -1`, (error, stdout) => {
        if (error || !stdout.trim()) res(null);
        else res(stdout.trim().split("\n")[0] ?? null);
      });
    });
    if (found && existsSync(found)) resolvedPath = found;
  }
  if (!existsSync(resolvedPath)) {
    return { error: "Path not found", status: 404 as const, path: resolvedPath };
  }
  try {
    const stats = statSync(resolvedPath);
    const type = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
    return {
      data: {
        path: resolvedPath,
        name: basename(resolvedPath) || resolvedPath,
        type,
      },
      status: 200 as const,
    };
  } catch {
    return { error: "Cannot stat path", status: 500 as const, path: resolvedPath };
  }
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function getLinkPreview(targetUrl: string) {
  if (!targetUrl || !isValidHttpUrl(targetUrl)) {
    return { error: "Invalid or missing URL", status: 400 as const };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_PREVIEW_FETCH_TIMEOUT_MS);
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DenchClawBot/1.0; +https://dench.com)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { error: `Upstream returned ${response.status}`, status: 502 as const };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return {
        data: {
          url: targetUrl,
          domain: new URL(targetUrl).hostname,
        } satisfies LinkPreviewData,
        status: 200 as const,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { error: "No response body", status: 502 as const };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (totalBytes < LINK_PREVIEW_MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    reader.cancel().catch(() => {});

    const html = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    return {
      data: parseLinkPreviewMetadata(html, response.url || targetUrl),
      status: 200 as const,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Fetch failed", status: 502 as const };
  }
}

async function ensureWatcher(root: string) {
  if (sharedWatcherPromise && sharedRoot === root) return sharedWatcherPromise;
  if (sharedWatcherPromise && sharedRoot && sharedRoot !== root) {
    try {
      const watcher = await sharedWatcherPromise as { close: () => Promise<void> };
      await watcher.close();
    } catch {}
    sharedWatcherPromise = null;
    sharedRoot = null;
    watcherReady = false;
  }

  sharedRoot = root;
  sharedWatcherPromise = import("chokidar").then((chokidar) => {
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      usePolling: true,
      interval: 1500,
      binaryInterval: 3000,
      ignored: WATCH_IGNORED,
      depth: 5,
    });
    watcher.on("all", (eventType: string, filePath: string) => {
      const relPath = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
      for (const listener of listeners) listener(eventType, relPath);
    });
    watcher.once("ready", () => {
      watcherReady = true;
    });
    watcher.on("error", () => {});
    return watcher;
  }).catch(() => null);

  return sharedWatcherPromise;
}

async function stopWatcherIfIdle() {
  if (listeners.size > 0 || !sharedWatcherPromise) return;
  try {
    const watcher = await sharedWatcherPromise as { close: () => Promise<void> } | null;
    await watcher?.close();
  } catch {}
  sharedWatcherPromise = null;
  sharedRoot = null;
  watcherReady = false;
}

export async function createWorkspaceWatchStream(signal: AbortSignal) {
  const root = resolveWorkspaceRoot();
  if (!root) {
    return { error: "Workspace not found", status: 404 as const };
  }
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));
      const listener: Listener = (type, relPath) => {
        if (closed) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify({ type, path: relPath })}\n\n`));
          } catch {}
        }, 300);
      };
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {}
      }, 30_000);
      const teardown = () => {
        if (closed) return;
        closed = true;
        listeners.delete(listener);
        if (heartbeat) clearInterval(heartbeat);
        if (debounceTimer) clearTimeout(debounceTimer);
        void stopWatcherIfIdle();
      };
      signal.addEventListener("abort", teardown, { once: true });
      listeners.add(listener);
      await ensureWatcher(root);
      if (!sharedWatcherPromise) {
        controller.enqueue(encoder.encode("event: error\ndata: {\"error\":\"File watching unavailable\"}\n\n"));
      } else if (!watcherReady) {
        controller.enqueue(encoder.encode(": watcher-starting\n\n"));
      }
    },
    cancel() {
      closed = true;
    },
  });

  return {
    data: stream,
    status: 200 as const,
  };
}
