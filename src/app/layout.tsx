import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lichess Coach",
  description: "Casual chess vs Stockfish with live Claude coaching",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
