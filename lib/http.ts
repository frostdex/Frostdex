import { NextResponse } from "next/server";
import "server-only";
import { DeApiError } from "@/lib/api-clients";

export function apiErrorResponse(error: unknown) {
  if (error instanceof DeApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return NextResponse.json(
      { error: "The generation provider took too long to respond. Try again." },
      { status: 504 },
    );
  }
  if (error instanceof TypeError) {
    return NextResponse.json(
      { error: "Could not reach the deAPI generation service. Try again shortly." },
      { status: 502 },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "The request could not be completed." },
    { status: 500 },
  );
}

export function readProviderKey(request: Request) {
  return request.headers.get("x-deapi-api-key");
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new DeApiError("Request body must be valid JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DeApiError("Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}
