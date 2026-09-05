"use client";

import { Chess, type Square } from "chess.js";
import { useState } from "react";
import { Chessboard } from "react-chessboard";
import { castleSanIfKingToRook } from "@/lib/chess";

interface BoardProps {
  fen: string;
  orientation: "white" | "black";
  canMove: boolean;
  onMove: (uci: string) => void;
}

// Resolves a from→to gesture into a legal chess.js move, accepting the
// king-onto-own-rook castle gesture as well. Auto-queens promotions (V1).
function computeMove(fen: string, from: string, to: string) {
  const scratch = new Chess(fen);
  try {
    return scratch.move({ from, to, promotion: "q" });
  } catch {
    const castle = castleSanIfKingToRook(scratch, from, to);
    if (!castle) return null;
    try {
      return scratch.move(castle);
    } catch {
      return null;
    }
  }
}

export default function Board({ fen, orientation, canMove, onMove }: BoardProps) {
  const [selected, setSelected] = useState<Square | null>(null);

  // New position → clear selection (state-adjust-during-render pattern).
  const [lastFen, setLastFen] = useState(fen);
  if (lastFen !== fen) {
    setLastFen(fen);
    setSelected(null);
  }

  const myPrefix = orientation === "white" ? "w" : "b";

  const play = (from: string, to: string): boolean => {
    const move = computeMove(fen, from, to);
    if (!move) return false;
    setSelected(null);
    onMove(move.from + move.to + (move.promotion ?? ""));
    return true;
  };

  // Legal-move dots for the selected piece (lichess-style).
  const squareStyles: Record<string, React.CSSProperties> = {};
  if (selected && canMove) {
    squareStyles[selected] = { backgroundColor: "rgba(20, 85, 30, 0.4)" };
    const scratch = new Chess(fen);
    for (const move of scratch.moves({ square: selected, verbose: true })) {
      squareStyles[move.to] = move.captured
        ? {
            background:
              "radial-gradient(circle, transparent 56%, rgba(20, 85, 30, 0.45) 60%)",
          }
        : {
            background:
              "radial-gradient(circle, rgba(20, 85, 30, 0.45) 24%, transparent 27%)",
          };
    }
    // Castle gesture affordance: dot on the own rook the king may castle with.
    const king = scratch.get(selected);
    if (king?.type === "k") {
      for (const move of scratch.moves({ square: selected, verbose: true })) {
        if (move.san === "O-O" || move.san === "O-O-O") {
          const rank = selected[1];
          const rookFile = move.san === "O-O" ? "h" : "a";
          squareStyles[`${rookFile}${rank}`] = {
            background:
              "radial-gradient(circle, rgba(20, 85, 30, 0.45) 24%, transparent 27%)",
          };
        }
      }
    }
  }

  return (
    <Chessboard
      options={{
        position: fen,
        boardOrientation: orientation,
        allowDragging: canMove,
        canDragPiece: ({ piece }) => canMove && piece.pieceType.startsWith(myPrefix),
        squareStyles,
        onPieceDrag: ({ square }) => {
          if (square) setSelected(square as Square);
        },
        onPieceDrop: ({ sourceSquare, targetSquare }) => {
          if (!canMove || !targetSquare) return false;
          return play(sourceSquare, targetSquare);
        },
        onSquareClick: ({ piece, square }) => {
          if (!canMove) return;
          if (selected) {
            if (square === selected) {
              setSelected(null);
              return;
            }
            // Includes clicking the own rook while the king is selected → castle.
            if (play(selected, square)) return;
          }
          if (piece && piece.pieceType.startsWith(myPrefix)) {
            setSelected(square as Square);
          } else {
            setSelected(null);
          }
        },
        animationDurationInMs: 150,
      }}
    />
  );
}
