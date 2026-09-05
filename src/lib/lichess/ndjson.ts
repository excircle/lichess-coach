// Adapted from the vendored api/scripts/update-examples/config.ts readNdJson
// (lines 77-101), with two contract changes per PLAN.md amendment A1:
//   1. every raw line — INCLUDING blank keepalives — is surfaced (onRawLine)
//      and bumps lastByteAt, so a watchdog can distinguish silence from thinking;
//   2. the close cause is reported ("end" | "aborted" | "error") instead of
//      AbortError being swallowed, so finish, deliberate abort, and network
//      drop are distinguishable.

export type StreamClose =
  | { type: "end" } // server closed the stream (normal at game end)
  | { type: "aborted" } // we aborted deliberately (watchdog, shutdown)
  | { type: "error"; error: unknown };

export interface NdjsonStream {
  done: Promise<StreamClose>;
  abort: () => void;
  lastByteAt: () => number; // epoch ms of the last received chunk
}

export function streamNdjson<T = unknown>(opts: {
  url: string;
  token: string;
  onJson: (value: T) => void;
  onRawLine?: (line: string) => void;
}): NdjsonStream {
  const controller = new AbortController();
  let lastByteAt = Date.now();

  const done: Promise<StreamClose> = (async () => {
    try {
      const res = await fetch(opts.url, {
        headers: { Authorization: `Bearer ${opts.token}` },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        return {
          type: "error" as const,
          error: new Error(`HTTP ${res.status} streaming ${opts.url}`),
        };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) lastByteAt = Date.now();
        buf += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });
        const parts = buf.split(/\r?\n/);
        if (!done) buf = parts.pop() ?? "";
        for (const part of parts) {
          opts.onRawLine?.(part);
          const trimmed = part.trim();
          if (trimmed) opts.onJson(JSON.parse(trimmed) as T);
        }
      }
      return { type: "end" as const };
    } catch (error) {
      if (controller.signal.aborted) return { type: "aborted" as const };
      return { type: "error" as const, error };
    }
  })();

  return {
    done,
    abort: () => controller.abort(),
    lastByteAt: () => lastByteAt,
  };
}
