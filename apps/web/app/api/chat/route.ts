import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.text();
    return proxyControlApiStream("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: req.signal,
    });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}
