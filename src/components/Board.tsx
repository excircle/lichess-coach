"use client";

import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

interface BoardProps {
  fen: string;
  orientation: "white" | "black";
  canMove: boolean;
  onMove: (uci: string) => void;
}

export default function Board({ fen, orientation, canMove, onMove }: BoardProps) {
  return (
    <Chessboard
      options={{
        position: fen,
        boardOrientation: orientation,
        allowDragging: canMove,
        canDragPiece: ({ piece }) =>
          canMove && piece.pieceType.startsWith(orientation === "white" ? "w" : "b"),
        onPieceDrop: ({ sourceSquare, targetSquare }) => {
          if (!canMove || !targetSquare) return false;
          const scratch = new Chess(fen);
          let move;
          try {
            // Auto-queen promotion in V1.
            move = scratch.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
          } catch {
            return false; // illegal — snap back
          }
          const promotion = move.promotion ?? "";
          onMove(sourceSquare + targetSquare + promotion);
          return true;
        },
        animationDurationInMs: 150,
      }}
    />
  );
}
