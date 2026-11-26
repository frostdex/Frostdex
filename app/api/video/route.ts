import { NextResponse } from "next/server";
import { createVideoJob } from "@/lib/api-clients";
import { apiErrorResponse, readJsonObject, readProviderKey } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

const durations = new Set([4, 5, 6, 8, 10, 12]);

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.trim().length > 1000) {
      return NextResponse.json(
        { error: "Video prompt must be between 1 and 1,000 characters." },
        { status: 400 },
      );
    }
    if (!Number.isInteger(body.duration) || !durations.has(Number(body.duration))) {
      return NextResponse.json(
        { error: "Choose a video duration of 4, 5, 6, 8, 10, or 12 seconds." },
        { status: 400 },
      );
    }
    if (body.aspectRatio !== "16:9" && body.aspectRatio !== "9:16") {
      return NextResponse.json(
        { error: "Choose a 16:9 or 9:16 aspect ratio." },
        { status: 400 },
      );
    }

    const job = await createVideoJob(
      {
        prompt: body.prompt.trim(),
        duration: Number(body.duration),
        aspectRatio: body.aspectRatio,
      },
      readProviderKey(request),
    );
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
