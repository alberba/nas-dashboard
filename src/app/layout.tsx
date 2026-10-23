import type { Metadata, Viewport } from "next";
import "@fontsource-variable/manrope";
import "@fontsource-variable/unbounded";
import "./globals.css";
export const metadata: Metadata = {
  title: "hub. — Tu NAS, a la vista",
  description: "Salud, recursos y control de tu NAS.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "hub.",
    statusBarStyle: "black-translucent",
  },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1b1a18",
  colorScheme: "dark",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
