import { authorizeDailySync, runDailySync } from "@/lib/daily-sync";
import { Problem } from "@/lib/model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    authorizeDailySync(request.headers.get("authorization"));
    return Response.json(await runDailySync());
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Problem ? error.message : "Daily sync failed.",
      },
      { status: error instanceof Problem ? error.status : 500 },
    );
  }
}
