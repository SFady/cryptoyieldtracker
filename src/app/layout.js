// app/layout.js
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import LayoutClient from "./components/LayoutClient"; // <-- wrapper with usePathname
import checkAuthent from "./lib/checkAuthent";
import { AuthProvider } from "./context/AuthContext";
import LoginForm from "./components/LoginForm";


const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Crypto Yield Tracker",
  description: "Crypto Yield Tracking",
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};



export default async function RootLayout({ children }) {
  const activeUser = await checkAuthent();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
      <div className="background-image" />
        <div className="gradient-overlay" />
        <main>
          <AuthProvider value={{ activeUser }}>
          <LayoutClient>
            {activeUser ? children : <LoginForm />}
          </LayoutClient>
          </AuthProvider>
        </main>
      </body>
    </html>
  );
}
