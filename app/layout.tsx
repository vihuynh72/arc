import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arc",
  description: "Learn the page one sweep at a time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
