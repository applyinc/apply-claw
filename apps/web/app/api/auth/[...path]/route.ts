import { getAuth } from "@/lib/auth/server";
import { type NextRequest } from "next/server";

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { GET } = getAuth().handler();
  return GET(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { POST } = getAuth().handler();
  return POST(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { PUT } = getAuth().handler();
  return PUT(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { DELETE } = getAuth().handler();
  return DELETE(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { PATCH } = getAuth().handler();
  return PATCH(request, context);
}
