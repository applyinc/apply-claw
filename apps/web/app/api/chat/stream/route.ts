import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    return proxyControlApiStream(`/chat/stream${url.search}`, {
      method: "GET",
      signal: req.signal,
    });
  } catch {
    return Response.json({ error: "Control API is not reachable." }, { status: 502 });
  }
}
