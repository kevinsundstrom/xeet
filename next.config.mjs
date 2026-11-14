import { withBotId } from "botid/next/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  serverExternalPackages: ["@xeet/core"],
  experimental: {
    sri: {
      algorithm: "sha256",
    },
  },
  outputFileTracingExcludes: {
    "*": ["./target/**/*", "./tmp/**/*", "./assets/**/*", "./crates/**/*"],
  },
  outputFileTracingIncludes: {
    "/%5Fplayground/[action]": [
      "./packages/xeet/package.json",
      "./packages/xeet/src/**/*",
      "./packages/xeet/wasm/package.json",
      "./packages/xeet/wasm/xeet_wasm.js",
      "./packages/xeet/wasm/xeet_wasm_bg.wasm",
    ],
    "/_playground/[action]": [
      "./packages/xeet/package.json",
      "./packages/xeet/src/**/*",
      "./packages/xeet/wasm/package.json",
      "./packages/xeet/wasm/xeet_wasm.js",
      "./packages/xeet/wasm/xeet_wasm_bg.wasm",
    ],
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/",
          has: [
            {
              type: "header",
              key: "accept",
              value: ".*text/markdown.*",
            },
          ],
          destination: "/index.md",
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Vary",
            value: "Accept",
          },
        ],
      },
      {
        source: "/wasm/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default withBotId(nextConfig);
