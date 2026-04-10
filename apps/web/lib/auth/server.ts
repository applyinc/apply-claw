import { createNeonAuth, type NeonAuth } from "@neondatabase/auth/next/server";

let _auth: NeonAuth | null = null;

export function getAuth(): NeonAuth {
  if (!_auth) {
    _auth = createNeonAuth({
      baseUrl: process.env.NEON_AUTH_BASE_URL!,
      cookies: {
        secret: process.env.NEON_AUTH_COOKIE_SECRET!,
      },
    });
  }
  return _auth;
}
