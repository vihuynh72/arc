import type { Metadata } from "next";
import { Atkinson_Hyperlegible, Instrument_Serif, Inter } from "next/font/google";
import { BOOT } from "@/lib/client/display";
import "./globals.css";
import "./profiles.css";

const serif = Instrument_Serif({ weight: "400", style: ["normal", "italic"], subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = Inter({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-sans", display: "swap" });
// Only downloaded when the Legible typeface is chosen (app/profiles.css).
const legible = Atkinson_Hyperlegible({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-legible", display: "swap", preload: false });

export const metadata: Metadata = {
  title: "Arc",
  description: "Learn the page one sweep at a time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${legible.variable}`} suppressHydrationWarning>
      <head>
        {/* Display profile attributes before first paint (lib/client/display.ts). */}
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body>
        <a className="skip" href="#content">
          Skip to the page
        </a>
        {children}
      </body>
    </html>
  );
}
