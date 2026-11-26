import { NextResponse } from "next/server";
import { createMusicJob } from "@/lib/api-clients";
import { apiErrorResponse, readJsonObject, readProviderKey } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (typeof body.caption !== "string" || !body.caption.trim() || body.caption.trim().length > 1000) {
      return NextResponse.json(
        { error: "Caption must be between 1 and 1,000 characters." },
        { status: 400 },
      );
    }
    if (typeof body.lyrics !== "string" || body.lyrics.length > 5000) {
      return NextResponse.json(
        { error: "Lyrics must be 5,000 characters or fewer." },
        { status: 400 },
      );
    }
    if (!Number.isInteger(body.duration) || Number(body.duration) < 30 || Number(body.duration) > 300) {
      return NextResponse.json(
        { error: "Choose a duration between 30 and 300 seconds." },
        { status: 400 },
      );
    }

    const job = await createMusicJob(
      {
        caption: body.caption.trim(),
        lyrics: body.lyrics,
        duration: Number(body.duration),
      },
      readProviderKey(request),
    );
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
