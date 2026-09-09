import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildDbSnapshot,
  ensureGameManager,
} from "@/lib/games/manager";
import type { GameEventPayload } from "@/lib/games/types";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// SSE: snapshot on connect, then state/finish deltas; `: ping` every 15s.
// Native EventSource auto-reconnect re-hits this route and gets a fresh
// snapshot — no resume bookkeeping (PLAN.md).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { gameId } = await params;

  const dbSnapshot = buildDbSnapshot(gameId);
  if (!dbSnapshot) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const manager = dbSnapshot.finished ? null : ensureGameManager(gameId);

      if (!manager) {
        // Finished (or unmanageable) game: snapshot + finish, then close.
        send("snapshot", dbSnapshot);
        if (dbSnapshot.finished) send("finish", dbSnapshot);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      send("snapshot", manager.getSnapshot());

      const onEvent = (payload: GameEventPayload) => {
        if (payload.type === "state" || payload.type === "finish") {
          send(payload.type, payload.snapshot);
        } else if (payload.type === "eval") {
          send("eval", payload.eval);
        } else if (payload.type === "opening") {
          // OS-A2: explicit case — the bare else would ship it as `coach`.
          send("opening", payload.opening);
        } else {
          send("coach", payload.coach);
        }
      };
      manager.on("event", onEvent);

      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(ping);
        manager.off("event", onEvent);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
