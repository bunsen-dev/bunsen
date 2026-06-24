import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ShaderBackground } from "@/components/ShaderBackground";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

const title = "Bunsen — Any agent. Any experiment. Deep evals.";
const description =
  "Bunsen is a source-available, autonomous research lab for agentic systems. Run any agent on any experiment in a container, score it with deep agentic evals, and compare across harnesses — for humans and AI alike.";

const ogImageAlt = "Bunsen — Any agent. Any experiment. Deep evals.";

export const metadata: Metadata = {
  metadataBase: new URL("https://bunsen.dev"),
  title,
  description,
  openGraph: {
    title: "Bunsen — An autonomous research lab for agentic systems",
    description:
      "Any agent. Any experiment. Deep evals. A source-available research lab where Bunsen's own agents drive the agent under test, read its traces, and write up the findings, citing their evidence — so you can compare across models and harnesses.",
    type: "website",
    url: "https://bunsen.dev/",
    siteName: "Bunsen",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: ogImageAlt,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description:
      "A source-available, autonomous research lab for agentic systems. Any agent, any experiment, deep evals.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>
        <ShaderBackground />
        {children}
      </body>
    </html>
  );
}
