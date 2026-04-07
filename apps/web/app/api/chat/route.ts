import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  return proxyControlApiStream("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: req.signal,
  });
}
