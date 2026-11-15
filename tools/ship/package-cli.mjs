#!/usr/bin/env node
// Builds the npm packages for `npm i -g @xeet/cli` from prebuilt self-contained
// native binaries (all fonts embedded in `__const` / `.rdata`).
//
//   node tools/ship/package-cli.mjs --bin darwin-arm64=target/release/xeet [--bin linux-x64=…] [--out dist/npm]
//
// Writes one package per platform (`@xeet/cli-<platform>`, in directory
// `cli-<platform>`, with `os`, `cpu`, and `libc` set so npm/pnpm installs only
// the matching single-file native executable) plus `@xeet/cli` itself (in
// directory `cli`), all at the workspace version.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "win32-arm64": { os: "win32", cpu: "arm64" },
  "win32-x64": { os: "win32", cpu: "x64" },
};

const args = process.argv.slice(2);
const bins = {};
let out = join(ROOT, "dist", "npm");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bin") {
    const eq = args[++i]?.indexOf("=") ?? -1;
    if (eq <= 0) throw new Error("--bin expects <platform>=<path>");
    const platform = args[i].slice(0, eq);
    const path = args[i].slice(eq + 1);
    if (!TARGETS[platform]) throw new Error(`unknown platform ${platform}`);
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(`binary for ${platform} does not exist or is empty: ${path}`);
    }
    bins[platform] = path;
  } else if (args[i] === "--out") {
    out = args[++i];
  } else {
    throw new Error(`unknown argument: ${args[i]}`);
  }
}
if (!Object.keys(bins).length) {
  console.error("usage: package-cli.mjs --bin <platform>=<path> [...] [--out dir]");
  process.exit(2);
}

const version = readFileSync(join(ROOT, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
const base = JSON.parse(readFileSync(join(ROOT, "packages", "xeet-cli", "package.json"), "utf8"));
const licensePath = join(ROOT, "LICENSE");
rmSync(out, { recursive: true, force: true });

for (const [platform, path] of Object.entries(bins)) {
  const { os, cpu, libc } = TARGETS[platform];
  const name = `@xeet/cli-${platform}`;
  const dir = join(out, `cli-${platform}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const exe = os === "win32" ? "xeet.exe" : "xeet";
  cpSync(path, join(dir, "bin", exe));
  chmodSync(join(dir, "bin", exe), 0o755);
  if (existsSync(licensePath)) cpSync(licensePath, join(dir, "LICENSE"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        type: "commonjs",
        description: `Prebuilt self-contained xeet native binary for ${platform}. Install @xeet/cli instead.`,
        license: base.license,
        repository: { type: "git", url: "https://github.com/rauchg/xeet" },
        homepage: base.homepage,
        bugs: base.bugs,
        publishConfig: { access: "public" },
        os: [os],
        cpu: [cpu],
        ...(libc ? { libc: [libc] } : {}),
        bin: { xeet: `bin/${exe}` },
        files: ["bin"],
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
  optionalDependencies: Object.fromEntries(
    Object.keys(bins)
      .sort()
      .map((p) => [`@xeet/cli-${p}`, version]),
  ),
};
writeFileSync(join(main, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${base.name}@${version} → ${out}`);
