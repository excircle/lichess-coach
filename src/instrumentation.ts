// Guarded per PLAN.md amendment A5: only the nodejs runtime may touch
// better-sqlite3 / child_process, and the import must be dynamic so the edge
// bundle never sees them.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("@/lib/boot");
    await boot();
  }
}
