import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  console.log("[api/chat] POST handler entered, body length=", body.length);
  const res = await proxyControlApiStream("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: req.signal,
  });
  console.log("[api/chat] POST response: status=", res.status, "hasBody=", !!res.body);
  return res;
}
