import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Frostwave Studio",
  description: "Create original music and short videos from a text prompt.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
