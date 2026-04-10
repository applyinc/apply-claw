import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const upstream = await fetchControlApi("/model-auth/openai-codex/login/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await upstream.json().catch(() => ({ error: "OAuth callback failed." }));
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}
