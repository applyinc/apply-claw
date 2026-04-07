import { access, readFile, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import { resolveWorkspaceRoot } from "./workspace-service.js";

// ── Bridge SDK ──

function generateBridgeScript(): string {
  // Minified bridge SDK - provides window.dench for app-to-DenchClaw communication
  return `
(function() {
  if (window.dench) return;
  var _p = {}, _rid = 0, _sc = {}, _sid = 0, _el = {}, _th = {}, _amh = null, _wh = {};
  function sr(m, p) {
    return new Promise(function(r, j) {
      var id = ++_rid;
      _p[id] = { resolve: r, reject: j };
      window.parent.postMessage({ type: "dench:request", id: id, method: m, params: p }, "*");
      setTimeout(function() { if (_p[id]) { _p[id].reject(new Error("Request timeout: " + m)); delete _p[id]; } }, 30000);
    });
  }
  function ssr(m, p, onE) {
    return new Promise(function(r, j) {
      var id = ++_rid, sid = ++_sid;
      _sc[sid] = onE;
      _p[id] = { resolve: function(res) { delete _sc[sid]; r(res); }, reject: function(e) { delete _sc[sid]; j(e); } };
      window.parent.postMessage({ type: "dench:request", id: id, method: m, params: Object.assign({}, p, { _streamId: sid }) }, "*");
      setTimeout(function() { if (_p[id]) { delete _sc[sid]; _p[id].reject(new Error("Request timeout: " + m)); delete _p[id]; } }, 300000);
    });
  }
  window.addEventListener("message", function(e) {
    if (!e.data) return;
    var d = e.data;
    if (d.type === "dench:response") { var p = _p[d.id]; if (!p) return; delete _p[d.id]; d.error ? p.reject(new Error(d.error)) : p.resolve(d.result); }
    else if (d.type === "dench:stream") { var cb = _sc[d.streamId]; if (cb) cb({ type: d.event, data: d.data, name: d.name, args: d.args, result: d.result }); }
    else if (d.type === "dench:event") {
      var ch = d.channel;
      if (ch === "apps.message" && _amh) _amh(d.data);
      if (ch && ch.indexOf("webhooks.") === 0) { var whCb = _wh[ch.substring(9)]; if (whCb) whCb(d.data); }
      var ls = _el[ch]; if (ls) for (var i = 0; i < ls.length; i++) try { ls[i](d.data); } catch(ex) { console.error("Event handler error:", ex); }
    }
    else if (d.type === "dench:tool-invoke") {
      var h = _th[d.toolName];
      if (h) Promise.resolve().then(function() { return h(d.args); }).then(function(res) {
        window.parent.postMessage({ type: "dench:tool-response", invokeId: d.invokeId, result: res }, "*");
      }).catch(function(err) {
        window.parent.postMessage({ type: "dench:tool-response", invokeId: d.invokeId, error: err.message || "Tool handler failed" }, "*");
      });
    }
  });
  window.dench = {
    db: { query: function(s) { return sr("db.query", { sql: s }); }, execute: function(s) { return sr("db.execute", { sql: s }); } },
    objects: { list: function(n, o) { return sr("objects.list", Object.assign({ name: n }, o || {})); }, get: function(n, e) { return sr("objects.get", { name: n, entryId: e }); }, create: function(n, f) { return sr("objects.create", { name: n, fields: f }); }, update: function(n, e, f) { return sr("objects.update", { name: n, entryId: e, fields: f }); }, delete: function(n, e) { return sr("objects.delete", { name: n, entryId: e }); }, bulkDelete: function(n, e) { return sr("objects.bulkDelete", { name: n, entryIds: e }); }, getSchema: function(n) { return sr("objects.getSchema", { name: n }); }, getOptions: function(n, q) { return sr("objects.getOptions", { name: n, query: q }); } },
    files: { read: function(p) { return sr("files.read", { path: p }); }, list: function(d) { return sr("files.list", { dir: d }); }, write: function(p, c) { return sr("files.write", { path: p, content: c }); }, delete: function(p) { return sr("files.delete", { path: p }); }, mkdir: function(p) { return sr("files.mkdir", { path: p }); } },
    app: { getManifest: function() { return sr("app.getManifest"); }, getTheme: function() { return sr("app.getTheme"); } },
    chat: { createSession: function(t) { return sr("chat.createSession", { title: t }); }, send: function(s, m, o) { if (o && o.onEvent) return ssr("chat.send", { sessionId: s, message: m }, o.onEvent); return sr("chat.send", { sessionId: s, message: m }); }, getHistory: function(s) { return sr("chat.getHistory", { sessionId: s }); }, getSessions: function(o) { return sr("chat.getSessions", o || {}); }, abort: function(s) { return sr("chat.abort", { sessionId: s }); }, isActive: function(s) { return sr("chat.isActive", { sessionId: s }); } },
    agent: { send: function(m) { return sr("agent.send", { message: m }); } },
    tool: { register: function(n, h) { _th[n] = h; return sr("tool.register", { name: n }); } },
    memory: { get: function() { return sr("memory.get"); } },
    ui: { toast: function(m, o) { return sr("ui.toast", Object.assign({ message: m }, o || {})); }, navigate: function(p) { return sr("ui.navigate", { path: p }); }, openEntry: function(o, e) { return sr("ui.openEntry", { objectName: o, entryId: e }); }, setTitle: function(t) { return sr("ui.setTitle", { title: t }); }, confirm: function(m) { return sr("ui.confirm", { message: m }); }, prompt: function(m, d) { return sr("ui.prompt", { message: m, defaultValue: d }); } },
    store: { get: function(k) { return sr("store.get", { key: k }); }, set: function(k, v) { return sr("store.set", { key: k, value: v }); }, delete: function(k) { return sr("store.delete", { key: k }); }, list: function() { return sr("store.list"); }, clear: function() { return sr("store.clear"); } },
    http: { fetch: function(u, o) { return sr("http.fetch", Object.assign({ url: u }, o || {})); } },
    events: { on: function(c, cb) { if (!_el[c]) _el[c] = []; _el[c].push(cb); sr("events.subscribe", { channel: c }).catch(function() {}); }, off: function(c, cb) { if (!cb) delete _el[c]; else if (_el[c]) { _el[c] = _el[c].filter(function(x) { return x !== cb; }); if (!_el[c].length) delete _el[c]; } sr("events.unsubscribe", { channel: c }).catch(function() {}); } },
    context: { getWorkspace: function() { return sr("context.getWorkspace"); }, getAppInfo: function() { return sr("context.getAppInfo"); } },
    apps: { send: function(t, m) { return sr("apps.send", { targetApp: t, message: m }); }, on: function(e, cb) { if (e === "message") _amh = cb; }, list: function() { return sr("apps.list"); } },
    cron: { schedule: function(o) { return sr("cron.schedule", o); }, list: function() { return sr("cron.list"); }, run: function(j) { return sr("cron.run", { jobId: j }); }, cancel: function(j) { return sr("cron.cancel", { jobId: j }); } },
    webhooks: { register: function(h) { return sr("webhooks.register", { hookName: h }); }, on: function(h, cb) { _wh[h] = cb; sr("webhooks.subscribe", { hookName: h }).catch(function() {}); }, poll: function(h, o) { return sr("webhooks.poll", Object.assign({ hookName: h }, o || {})); } },
    clipboard: { read: function() { return sr("clipboard.read"); }, write: function(t) { return sr("clipboard.write", { text: t }); } }
  };
})();
`;
}

function injectBridgeIntoHtml(html: string): string {
  const script = `<script>${generateBridgeScript()}</script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${script}\n</head>`);
  if (html.includes("<head>")) return html.replace("<head>", `<head>\n${script}`);
  return `${script}\n${html}`;
}

// ── App file serving ──

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

function getMimeType(filepath: string): string {
  return MIME_TYPES[extname(filepath).toLowerCase()] || "application/octet-stream";
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function splitAppPath(path: string): { appPath: string; filePath: string } | null {
  const marker = ".dench.app";
  const idx = path.indexOf(marker);
  if (idx === -1) return null;
  const appEnd = idx + marker.length;
  const appPath = path.slice(0, appEnd);
  const filePath = path.slice(appEnd + 1) || "index.html";
  return { appPath, filePath };
}

export async function serveAppFile(path: string): Promise<Response> {
  const split = splitAppPath(path);
  if (!split) {
    return Response.json({ error: "Invalid app path — must contain .dench.app" }, { status: 400 });
  }

  const { appPath, filePath } = split;
  const workspaceRootDir = resolveWorkspaceRoot();
  if (!workspaceRootDir) {
    return Response.json({ error: "No workspace configured" }, { status: 404 });
  }

  const appAbsPath = resolve(join(workspaceRootDir, appPath));
  if (relative(workspaceRootDir, appAbsPath).startsWith("..")) {
    return Response.json({ error: "Path traversal denied" }, { status: 403 });
  }

  const fileAbsPath = resolve(join(appAbsPath, filePath));
  if (relative(appAbsPath, fileAbsPath).startsWith("..")) {
    return Response.json({ error: "Path traversal denied" }, { status: 403 });
  }

  if (!await pathExists(fileAbsPath)) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const fileStat = await stat(fileAbsPath);
    if (!fileStat.isFile()) {
      return Response.json({ error: "Not a file" }, { status: 400 });
    }

    const mimeType = getMimeType(filePath);
    const ext = extname(filePath).toLowerCase();

    if (ext === ".html" || ext === ".htm") {
      const htmlContent = await readFile(fileAbsPath, "utf-8");
      const injected = injectBridgeIntoHtml(htmlContent);
      return new Response(injected, {
        headers: { "Content-Type": mimeType, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
      });
    }

    const content = await readFile(fileAbsPath);
    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(content.length),
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "Failed to read file" }, { status: 500 });
  }
}

// ── CORS Proxy ──

const PRIVATE_IP = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|localhost|::1|\[::1\])/i;

export async function corsProxy(body: { url?: string; method?: string; headers?: Record<string, string>; body?: string }) {
  const { url } = body;
  if (!url || typeof url !== "string") {
    return { error: "Missing 'url' field", status: 400 as const };
  }

  let parsed: URL;
  try { parsed = new URL(url); } catch { return { error: "Invalid URL", status: 400 as const }; }

  if (PRIVATE_IP.test(parsed.hostname)) {
    return { error: "Requests to private/local addresses are not allowed", status: 403 as const };
  }

  try {
    const resp = await fetch(url, {
      method: body.method || "GET",
      headers: body.headers || {},
      body: body.method && body.method !== "GET" && body.method !== "HEAD" ? body.body : undefined,
    });
    const respBody = await resp.text();
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });

    return { data: { status: resp.status, statusText: resp.statusText, headers: respHeaders, body: respBody }, status: 200 as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Fetch failed", status: 502 as const };
  }
}

// ── Webhooks ──

type WebhookEvent = {
  method: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
};

const MAX_EVENTS_PER_HOOK = 100;
const webhookStore = new Map<string, WebhookEvent[]>();

function pushWebhookEvent(key: string, event: WebhookEvent) {
  let events = webhookStore.get(key);
  if (!events) { events = []; webhookStore.set(key, events); }
  events.push(event);
  if (events.length > MAX_EVENTS_PER_HOOK) events.splice(0, events.length - MAX_EVENTS_PER_HOOK);
}

export function handleWebhookIncoming(key: string, method: string, headers: Record<string, string>, body: string) {
  pushWebhookEvent(key, { method, headers, body, receivedAt: Date.now() });
  return { data: { ok: true, received: true }, status: 200 as const };
}

export function getWebhookEvents(key: string, since?: number) {
  const events = webhookStore.get(key) || [];
  const sinceTs = since ?? 0;
  const filtered = events.filter((e) => e.receivedAt > sinceTs);
  return { data: { events: filtered }, status: 200 as const };
}

// ── App Store (key-value) ──

function appStorePath(appName: string): string | null {
  const wsRoot = resolveWorkspaceRoot();
  if (!wsRoot) return null;
  return join(wsRoot, ".dench-app-data", appName, "store.json");
}

function readAppStore(appName: string): Record<string, unknown> {
  const p = appStorePath(appName);
  if (!p || !existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function writeAppStore(appName: string, data: Record<string, unknown>): boolean {
  const p = appStorePath(appName);
  if (!p) return false;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  return true;
}

export function getAppStoreValue(app: string, key?: string | null) {
  if (!app) return { error: "Missing 'app' param", status: 400 as const };
  const store = readAppStore(app);
  if (key) return { data: { value: store[key] ?? null }, status: 200 as const };
  return { data: { keys: Object.keys(store) }, status: 200 as const };
}

export function setAppStoreValue(app: string, key: string, value: unknown) {
  if (!app || !key) return { error: "Missing 'app' or 'key'", status: 400 as const };
  const store = readAppStore(app);
  store[key] = value;
  writeAppStore(app, store);
  return { data: { ok: true }, status: 200 as const };
}

export function deleteAppStoreValue(app: string, key?: string | null) {
  if (!app) return { error: "Missing 'app' param", status: 400 as const };
  const store = readAppStore(app);
  if (key) { delete store[key]; } else { for (const k of Object.keys(store)) delete store[k]; }
  writeAppStore(app, store);
  return { data: { ok: true }, status: 200 as const };
}
