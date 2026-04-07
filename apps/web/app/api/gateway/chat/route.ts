import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  return proxyControlApiStream("/gateway/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
