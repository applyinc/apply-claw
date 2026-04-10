import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const upstream = await fetchControlApi("/model-auth/openai-codex", { method: "GET" });
    const data = await upstream.json().catch(() => ({ profiles: [] }));
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}

export async function POST() {
  try {
    const upstream = await fetchControlApi("/model-auth/openai-codex", { method: "POST" });
    const data = await upstream.json().catch(() => ({ error: "Failed to refresh model auth" }));
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}
