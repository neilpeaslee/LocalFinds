import { readRegionConfig } from "@localfinds/db";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LocalFinds",
  description: "Curated local discoveries for your region",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const region = readRegionConfig();
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-3xl items-baseline justify-between px-4 py-4">
            <h1 className="text-lg font-semibold tracking-tight">
              <a href="/">LocalFinds</a>
              {region && (
                <span className="ml-2 font-normal text-stone-500">
                  — {region.name}
                </span>
              )}
            </h1>
            <nav className="flex gap-4 text-sm text-stone-600">
              <a href="/" className="hover:text-stone-900">
                Feed
              </a>
              <a href="/sources" className="hover:text-stone-900">
                Sources
              </a>
              <a href="/agents" className="hover:text-stone-900">
                Agents
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
