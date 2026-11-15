#!/usr/bin/env node
// `xeet`: dispatches directly to the self-contained native binary for this OS/CPU.
//
// Each platform package (`@xeet/cli-darwin-arm64`, …) is an optionalDependency
// carrying a single stripped Rust executable (`bin/xeet` or `bin/xeet.exe`) with
// all fonts embedded in read-only memory pages—no postinstall scripts, no
// runtime pack hashing, and no sibling asset lookups.

"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const PLATFORMS = {
  "darwin-arm64": "@xeet/cli-darwin-arm64",
  "darwin-x64": "@xeet/cli-darwin-x64",
  "linux-arm64": "@xeet/cli-linux-arm64",
  "linux-x64": "@xeet/cli-linux-x64",
  "win32-arm64": "@xeet/cli-win32-arm64",
  "win32-x64": "@xeet/cli-win32-x64",
};

function isMuslLinux() {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function binaryPath() {
  if (process.env.XEET_BINARY) return process.env.XEET_BINARY;

  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORMS[key];
  if (!pkg) {
    throw new Error(`xeet: no prebuilt binary for ${key}. Supported: ${Object.keys(PLATFORMS).join(", ")}.`);
  }

  const exe = process.platform === "win32" ? "xeet.exe" : "xeet";

  // Fast O(1) sibling lookup for both hoisted npm (`node_modules/@xeet/cli-*`)
  // and pnpm's virtual store (`.pnpm/@xeet+cli@.../node_modules/@xeet/cli-*`),
  // avoiding a full `require.resolve` directory walk on the hot path.
  const direct = join(__dirname, "..", "..", `cli-${key}`, "bin", exe);
  if (existsSync(direct)) return direct;

  let pkgJson;
  try {
    pkgJson = require.resolve(`${pkg}/package.json`);
  } catch {
    if (isMuslLinux()) {
      throw new Error(
        `xeet: prebuilt Linux binaries require glibc (musl/Alpine detected; ${pkg} was skipped). ` +
          "Build from source with `cargo install --git https://github.com/rauchg/xeet xeet-cli`.",
      );
    }
    throw new Error(
      `xeet: the ${pkg} package is missing. It is an optional dependency of @xeet/cli; ` +
        "reinstall without --no-optional (or --omit=optional).",
    );
  }

  const resolved = join(pkgJson, "..", "bin", exe);
  if (!existsSync(resolved)) {
    throw new Error(`xeet: ${resolved} is missing from ${pkg}.`);
  }
  return resolved;
}

let bin;
try {
  bin = binaryPath();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`xeet: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
