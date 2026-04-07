import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxyWebhook(req: Request, params: Promise<{ path: string[] }>) {
  const { path } = await params;
  const key = path.join("/");
  const url = new URL(req.url);

  const upstream = await fetchControlApi(`/apps/webhooks/${key}${url.search}`, {
    method: req.method,
    headers: { "Content-Type": req.headers.get("Content-Type") || "text/plain" },
    body: req.method !== "GET" && req.method !== "HEAD" ? await req.text().catch(() => "") : undefined,
  });
  const data = await upstream.json().catch(() => ({ error: "Webhook proxy failed" }));
  return Response.json(data, { status: upstream.status });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyWebhook(req, ctx.params);
}
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyWebhook(req, ctx.params);
}
export async function PUT(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyWebhook(req, ctx.params);
}
export async function PATCH(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyWebhook(req, ctx.params);
}
export async function DELETE(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyWebhook(req, ctx.params);
}
