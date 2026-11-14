#!/usr/bin/env node
// `xeet`: runs the native binary for this platform.
//
// The binary ships in one package per platform (`@xeet/cli-darwin-arm64`, …),
// listed as optional dependencies, so npm installs only the one that matches
// `os` and `cpu`. This shim finds it and hands over stdin, stdout, stderr and
// the exit code untouched.

"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const PLATFORMS = {
  "darwin-arm64": "@xeet/cli-darwin-arm64",
  "darwin-x64": "@xeet/cli-darwin-x64",
  "linux-arm64": "@xeet/cli-linux-arm64",
  "linux-x64": "@xeet/cli-linux-x64",
  "win32-x64": "@xeet/cli-win32-x64",
};

function binaryPath() {
  // An explicit path wins: useful for a local build (`cargo build -p xeet-cli`).
  if (process.env.XEET_BINARY) return process.env.XEET_BINARY;
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORMS[key];
  if (!pkg) {
    throw new Error(`xeet: no prebuilt binary for ${key}. Supported: ${Object.keys(PLATFORMS).join(", ")}.`);
  }
  const exe = process.platform === "win32" ? "xeet.exe" : "xeet";
  let dir;
  try {
    dir = join(require.resolve(`${pkg}/package.json`), "..");
  } catch {
    throw new Error(
      `xeet: the ${pkg} package is missing. It is an optional dependency of @xeet/cli; ` +
        "reinstall without --no-optional (or --omit=optional).",
    );
  }
  const path = join(dir, "bin", exe);
  if (!existsSync(path)) throw new Error(`xeet: ${path} is missing from ${pkg}.`);
  return path;
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
process.exit(result.status ?? 1);
