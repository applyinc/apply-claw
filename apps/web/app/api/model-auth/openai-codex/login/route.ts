import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const upstream = await fetchControlApi(`/model-auth/openai-codex/login${new URL(req.url).search}`, {
      method: "GET",
    });
    const data = await upstream.json().catch(() => ({ error: "Failed to load login session" }));
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}

export async function POST() {
  try {
    const upstream = await fetchControlApi("/model-auth/openai-codex/login", {
      method: "POST",
    });
    const data = await upstream.json().catch(() => ({ error: "OpenAI login failed." }));
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}
