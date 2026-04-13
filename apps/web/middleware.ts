import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/server";

export default async function middleware(request: NextRequest) {
  const { pathname, method } = { pathname: request.nextUrl.pathname, method: request.method };
  if (pathname.startsWith("/api/chat") || pathname.startsWith("/api/web-sessions")) {
    console.log(`[middleware] ${method} ${pathname} — entering auth middleware`);
  }
  const authMiddleware = getAuth().middleware({ loginUrl: "/auth/sign-in" });
  const response = await authMiddleware(request);
  if (pathname.startsWith("/api/chat") || pathname.startsWith("/api/web-sessions")) {
    const status = response?.status ?? "no-response";
    const location = response?.headers?.get("location") ?? "";
    console.log(`[middleware] ${method} ${pathname} — auth result: status=${status} location=${location}`);
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, icons, images
     * - auth routes (sign-in, sign-up, etc.)
     * - api/auth routes (auth API handler)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.png$|auth/|api/auth/|api/model-auth/).*)",
  ],
};
