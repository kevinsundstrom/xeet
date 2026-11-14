#!/usr/bin/env node
// Builds the npm packages for `npm i -g @xeet/cli` from prebuilt binaries.
//
//   node tools/ship/package-cli.mjs --bin darwin-arm64=target/release/xeet [--bin linux-x64=…] [--out dist/npm]
//
// Writes one package per platform (`@xeet/cli-<platform>`, in directory
// `cli-<platform>`, with `os` and `cpu` set so npm installs only the matching
// one) plus `@xeet/cli` itself (in directory `cli`), all at the workspace
// version.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "win32-x64": { os: "win32", cpu: "x64" },
};

const args = process.argv.slice(2);
const bins = {};
let out = join(ROOT, "dist", "npm");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bin") {
    const [platform, path] = args[++i].split("=");
    if (!TARGETS[platform]) throw new Error(`unknown platform ${platform}`);
    bins[platform] = path;
  } else if (args[i] === "--out") {
    out = args[++i];
  }
}
if (!Object.keys(bins).length) {
  console.error("usage: package-cli.mjs --bin <platform>=<path> [...] [--out dir]");
  process.exit(2);
}

const version = readFileSync(join(ROOT, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
const base = JSON.parse(readFileSync(join(ROOT, "packages", "xeet-cli", "package.json"), "utf8"));
const licensePath = join(ROOT, "LICENSE");
const packs = join(ROOT, "packages", "xeet", "wasm", "fonts");
if (!existsSync(join(packs, "packs.json"))) {
  throw new Error("the lazy font packs are missing; run node tools/ship/build-font-packs.mjs first");
}
rmSync(out, { recursive: true, force: true });

for (const [platform, path] of Object.entries(bins)) {
  const { os, cpu, libc } = TARGETS[platform];
  const name = `@xeet/cli-${platform}`;
  const dir = join(out, `cli-${platform}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const exe = os === "win32" ? "xeet.exe" : "xeet";
  cpSync(path, join(dir, "bin", exe));
  chmodSync(join(dir, "bin", exe), 0o755);
  // The release binary embeds only Chirp + Arial; the CLI finds these packs at
  // `../fonts` relative to `bin/xeet` (see `commands::pack_dir`).
  cpSync(packs, join(dir, "fonts"), { recursive: true });
  if (existsSync(licensePath)) cpSync(licensePath, join(dir, "LICENSE"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        description: `Prebuilt xeet binary for ${platform}. Install @xeet/cli instead.`,
        license: base.license,
        repository: { type: "git", url: "https://github.com/vercel-labs/xeet" },
        homepage: base.homepage,
        bugs: base.bugs,
        publishConfig: { access: "public" },
        os: [os],
        cpu: [cpu],
        ...(libc ? { libc: [libc] } : {}),
        files: ["bin", "fonts"],
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${name}@${version}`);
}

const main = join(out, "cli");
mkdirSync(join(main, "bin"), { recursive: true });
cpSync(join(ROOT, "packages", "xeet-cli", "bin", "xeet.js"), join(main, "bin", "xeet.js"));
chmodSync(join(main, "bin", "xeet.js"), 0o755);
cpSync(join(ROOT, "packages", "xeet-cli", "README.md"), join(main, "README.md"));
if (existsSync(licensePath)) cpSync(licensePath, join(main, "LICENSE"));
const pkg = {
  ...base,
  version,
  optionalDependencies: Object.fromEntries(Object.keys(bins).map((p) => [`@xeet/cli-${p}`, version])),
};
writeFileSync(join(main, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${base.name}@${version} → ${out}`);
