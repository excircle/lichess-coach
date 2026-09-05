"use client";

import { useMutation } from "@tanstack/react-query";

export interface CreateGameParams {
  level: number;
  clockLimit: number | null; // seconds; null = unlimited
  clockIncrement: number | null; // seconds
  color: "white" | "black" | "random";
  coachMode: "auto" | "off";
}

export function useCreateGame() {
  return useMutation({
    mutationFn: async (params: CreateGameParams) => {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = (await res.json().catch(() => ({}))) as {
        gameId?: string;
        error?: string;
      };
      if (!res.ok || !body.gameId) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return { gameId: body.gameId };
    },
  });
}
