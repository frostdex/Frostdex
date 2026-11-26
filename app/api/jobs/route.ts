import { NextResponse } from "next/server";
import { getJobStatus } from "@/lib/api-clients";
import { apiErrorResponse, readProviderKey } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get("id") || "";
    const job = await getJobStatus(requestId, readProviderKey(request));
    return NextResponse.json(job);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
