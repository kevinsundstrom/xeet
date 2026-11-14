import { BotIdClient } from "botid/client";
import localFont from "next/font/local";
import { WASM_DIR } from "./_generated/wasm-manifest.js";
import "./globals.css";

const geistSerif = localFont({
  src: "./_assets/fonts/GeistSerif.woff2",
  weight: "100 900",
  display: "block",
  variable: "--font-serif",
});

const geistSans = localFont({
  src: "./_assets/fonts/GeistSans.woff2",
  weight: "100 900",
  display: "block",
  variable: "--font-sans",
});

const geistMono = localFont({
  src: "./_assets/fonts/GeistMono.woff2",
  weight: "100 900",
  display: "block",
  variable: "--font-mono",
});

export const metadata = {
  title: "xeet",
  description: "X posts rendered to PNG in WebAssembly. No browser.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23000'/%3E%3Cpath d='M50 26 73 70H27z' fill='%23fff'/%3E%3C/svg%3E",
  },
  alternates: {
    types: {
      "text/markdown": [{ url: "/index.md", title: "xeet docs (Markdown)" }],
    },
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

const THEME_INIT_SCRIPT = `try{const s=localStorage.getItem("xeet.theme");if(s==="light"||s==="dark")document.documentElement.dataset.theme=s;}catch{}`;
const TOGGLE_INIT_SCRIPT = `(()=>{const b=document.getElementById("themeToggle");if(!b)return;const s=document.documentElement.dataset.theme;const a=s||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");b.textContent=a==="dark"?"light":"dark";b.hidden=false;})();`;

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSerif.variable} ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="modulepreload" href={`${WASM_DIR}/xeet_wasm.js`} />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <BotIdClient
          protect={[
            { path: "/_playground/resolve", method: "POST" },
            { path: "/_playground/resolve-links", method: "POST" },
          ]}
        />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: TOGGLE_INIT_SCRIPT }} />
      </body>
    </html>
  );
}
