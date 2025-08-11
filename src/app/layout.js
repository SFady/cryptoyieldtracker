// app/layout.js
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import LayoutClient from "./components/LayoutClient"; // <-- wrapper with usePathname
import checkAuthent from "./lib/checkAuthent";
import { AuthProvider } from "./context/AuthContext";
import LogoutButton from "./components/LogoutButton"; // ⬅ new component
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
            {activeUser ? (
                <>
                  {children}
                  <br></br><LogoutButton /> {/* seulement si connecté */}
                </>
              ) : (
                <LoginForm />
              )}
          </LayoutClient>
          </AuthProvider>
        </main>
      </body>
    </html>
  );
}
