import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  return proxyControlApiStream(`/chat/stream${url.search}`, {
    method: "GET",
    signal: req.signal,
  });
}
