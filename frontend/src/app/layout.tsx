import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import { ClientProviders } from "./providers";
import "../index.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-instrument-sans",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7f8",
};

export const metadata: Metadata = {
  title: { default: "StatChecker AFL", template: "%s | StatChecker AFL" },
  description: "Open-source AFL player research: hit rates, same-game multis and game logs from your own data.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-US" className={`${instrumentSans.variable} ${instrumentSerif.variable}`}>
      <body className="font-sans antialiased">
        <ClientProviders>
          <div className="min-h-screen bg-background text-foreground">{children}</div>
        </ClientProviders>
      </body>
    </html>
  );
}
