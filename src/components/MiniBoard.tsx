"use client";

import { Chessboard } from "react-chessboard";

interface MiniBoardProps {
  fen: string;
  orientation: "white" | "black";
  arrow: string | null; // UCI of the move to draw, e.g. "g1f3"
}

// Non-interactive thumbnail with one suggestion arrow (PLAN OS §6.4) — the
// same Chessboard the main board uses, with a distinct id (OS-A6).
export default function MiniBoard({ fen, orientation, arrow }: MiniBoardProps) {
  return (
    <div className="w-[176px] shrink-0">
      <Chessboard
        options={{
          id: "opening-thumb",
          position: fen,
          boardOrientation: orientation,
          allowDragging: false,
          allowDrawingArrows: false,
          showNotation: false,
          animationDurationInMs: 0,
          arrows: arrow
            ? [
                {
                  startSquare: arrow.slice(0, 2),
                  endSquare: arrow.slice(2, 4),
                  color: "#15803d",
                },
              ]
            : [],
          boardStyle: { width: 176, borderRadius: 6 },
        }}
      />
    </div>
  );
}
