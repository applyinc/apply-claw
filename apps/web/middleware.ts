import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/server";

export default async function middleware(request: NextRequest) {
  const { pathname, method } = { pathname: request.nextUrl.pathname, method: request.method };
  const isApiRoute = pathname.startsWith("/api/");

  if (isApiRoute) {
    const cookieHeader = request.headers.get("cookie") || "";
    const hasSessionToken = cookieHeader.includes("__Secure-neon-auth.session_token");
    const hasSessionData = cookieHeader.includes("__Secure-neon-auth.local.session_data");
    console.log(`[middleware] ${method} ${pathname} — entering auth middleware (hasSessionToken=${hasSessionToken}, hasSessionData=${hasSessionData})`);
  }

  const authMiddleware = getAuth().middleware({ loginUrl: "/auth/sign-in" });
  const response = await authMiddleware(request);

  if (isApiRoute) {
    const status = response?.status ?? "no-response";
    const location = response?.headers?.get("location") ?? "";
    console.log(`[middleware] ${method} ${pathname} — auth result: status=${status} location=${location}`);

    // API routes should never receive redirects — return 401 JSON instead
    // so that fetch() callers get a proper error rather than an HTML page.
    if (response && (response.status === 307 || response.status === 302)) {
      console.log(`[middleware] ${method} ${pathname} — converting redirect to 401 JSON for API route`);
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
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
