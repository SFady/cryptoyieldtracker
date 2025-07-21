// app/layout.js
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import LayoutClient from "./components/LayoutClient"; // <-- wrapper with usePathname

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "The Crypto Athletes Club",
  description: "Sport for Crypto",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
      <div className="background-image" />
        <div className="gradient-overlay" />
        <main>
          <LayoutClient>{children}</LayoutClient>
        </main>
      </body>
    </html>
  );
}
