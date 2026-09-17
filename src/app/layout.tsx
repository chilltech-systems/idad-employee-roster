import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "IDAD Employee Report Directory",
  description: "Store employee directory and schedule identity management",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
