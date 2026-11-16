#!/usr/bin/env node
// Builds the WebAssembly module and installs it in the Node package.
//
//   node tools/ship/build-wasm.mjs [--debug] [--out path]
//
// Why a script instead of a build hook: the module has to be built with the
// `wasm32-unknown-unknown` target, and this machine has two Rust installs (a
// Homebrew `cargo` that has no extra targets, and rustup's `stable`, which
// does). The script finds a toolchain whose sysroot actually contains the
// wasm32 standard library, and says so when none does.
//
// Note: `rustup run stable cargo` is *not* enough here. The shim keeps
// `RUSTUP_TOOLCHAIN` set and the Homebrew `rustc` still wins the lookup, which
// fails with "can't find crate for `core`". Prepending the toolchain's `bin`
// to PATH is what works, so that is what this script does.
//
// The output is not committed (`packages/xeet/wasm/*.wasm` is git-ignored);
// CI builds it before testing and publishing.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { buildFontPacks } from "./build-font-packs.mjs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET = "wasm32-unknown-unknown";
const args = process.argv.slice(2);
const profile = args.includes("--debug") ? "debug" : "release";
const outFlag = args.indexOf("--out");
const OUT = outFlag >= 0 ? args[outFlag + 1] : join(ROOT, "packages", "xeet", "wasm", "xeet_wasm.wasm");
const TARGET_DIR = process.env.XEET_WASM_TARGET_DIR ?? join(ROOT, "target", "ship-wasm");

function probe(command, commandArgs) {
  try {
    execFileSync(command, commandArgs, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cargo invocations to try, best first: every rustup toolchain whose sysroot
 * has the wasm32 standard library, then the `cargo` on PATH (CI images install
 * the target into their only toolchain, so that is usually right).
 */
function candidates() {
  const list = [];
  if (probe("rustup", ["toolchain", "list", "-v"])) {
    const out = execFileSync("rustup", ["toolchain", "list", "-v"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s+\((?:active|default)[^)]*\)\s+(\/.*)$/) ?? line.match(/^(\S+)\s+.*?(\/\S+)\s*$/);
      if (!m) continue;
      const [, name, dir] = m;
      if (!existsSync(join(dir, "lib", "rustlib", TARGET, "lib"))) continue;
      list.push({
        name,
        command: join(dir, "bin", "cargo"),
        prefix: [],
        env: {
          ...process.env,
          ...env,
          PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
          // rust-lld on this machine has an rpath that does not find its own
          // libLLVM.dylib ("Library not loaded: @rpath/libLLVM.dylib"). The
          // dylib is in the toolchain's lib/, so point dyld there. Harmless
          // where the rpath is correct.
          DYLD_LIBRARY_PATH: [join(dir, "lib"), process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
        },
      });
    }
  }
  list.push({ name: "cargo on PATH", command: "cargo", prefix: [], env: { ...process.env, ...env } });
  return list;
}

const cargoArgs = ["build", "-p", "xeet-wasm", "--target", TARGET, "--target-dir", TARGET_DIR];
if (profile === "release") cargoArgs.push("--release");

// Fat LTO miscompiles the rasterizer on wasm32.
//
// The workspace `[profile.release]` sets `lto = "fat"`, which is right for the
// native binaries. Built for wasm32 with fat LTO, `tiny_skia`'s `fill_path`
// produces distorted spans: large rounded rectangles (media and card
// placeholders) come out as skewed trapezoids with missing rows, while glyphs,
// circles and icons stay correct. Thin LTO and no LTO both render correctly and
// produce byte-identical output to each other, so thin LTO it is: it keeps most
// of the size win without the miscompile.
//
// `tools/ship/determinism.mjs` is what caught this (native and wasm PNGs
// differed), and it is the check that keeps it caught: a miscompiled raster
// shows up as a byte difference, because the same source produced both.
const LTO = process.env.XEET_WASM_LTO ?? "thin";
// `strip = true` in the workspace release profile removes the `target_features`
// custom section that wasm-bindgen reads to decide which Wasm features the glue
// may use. The glue stays correct without it, but it warns, and a stripped
// module cannot be re-optimized with wasm-opt later. Keep the section.
//
// WASM SIMD (128-bit) is on by default. LLVM vectorizes the rasterizer's inner
// loops — span blending, glyph masks, resampling — during codegen, so it costs
// no extra build step and no extra pass over the module. `XEET_WASM_SIMD=0`
// builds a baseline module for an old engine, and anything already in the
// variable is kept so a hand-set `-C target-feature=…` still composes.
const SIMD = process.env.XEET_WASM_SIMD !== "0";
const RUSTFLAGS = [process.env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS, SIMD ? "-C target-feature=+simd128" : ""]
  .map((flags) => (flags ?? "").trim())
  .filter(Boolean)
  .join(" ");
const env = {
  CARGO_PROFILE_RELEASE_LTO: LTO,
  CARGO_PROFILE_RELEASE_STRIP: "false",
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: RUSTFLAGS,
  // Only Chirp and Arial are embedded in the module; `emoji`, `math`, `cjk`,
  // `arabic`, `hebrew` and `latin` are separate packs the host registers on
  // demand. `XEET_FONT_PACKS=all` builds the old 45 MB module instead, which is
  // what the determinism check would use if it wanted a self-contained one.
  XEET_FONT_PACKS: process.env.XEET_FONT_PACKS ?? "core",
};

let built = false;
const failures = [];
for (const c of candidates()) {
  const full = [...c.prefix, ...cargoArgs];
  try {
    execFileSync(c.command, full, { cwd: ROOT, stdio: "pipe", encoding: "utf8", env: c.env });
    console.log(`wasm: built with ${c.name}`);
    built = true;
    break;
  } catch (e) {
    failures.push(`${c.name}: ${(e.stderr || e.stdout || e.message).split("\n").slice(-4).join("\n")}`);
  }
}

if (!built) {
  console.error("wasm: no toolchain could build the module. Tried:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  console.error(`\nInstall the target for the toolchain you build with:\n\n    rustup target add ${TARGET}\n`);
  process.exit(1);
}
console.log(`wasm: ${SIMD ? "simd128 enabled" : "baseline (XEET_WASM_SIMD=0)"}`);

const artifact = join(TARGET_DIR, TARGET, profile, "xeet_wasm.wasm");
mkdirSync(dirname(OUT), { recursive: true });

// --- wasm-bindgen: the JS glue ---------------------------------------------
//
// The glue version must equal the `wasm-bindgen` crate version exactly, or the
// generated module and the Rust shims disagree about the ABI in ways that
// surface as silent corruption. Both are pinned to WASM_BINDGEN_VERSION.
const WASM_BINDGEN_VERSION = "0.2.130";
const bindgen = process.env.WASM_BINDGEN ?? ["wasm-bindgen", join(homedir(), ".cargo", "bin", "wasm-bindgen")].find((c) => {
  try {
    execFileSync(c, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
});

if (!bindgen) {
  console.error("wasm: `wasm-bindgen` is not installed. Install the pinned version:\n");
  console.error(`    cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked\n`);
  process.exit(1);
}
const version = execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim().split(" ").pop();
if (version !== WASM_BINDGEN_VERSION) {
  console.error(`wasm: wasm-bindgen ${version} does not match the crate pin ${WASM_BINDGEN_VERSION}.`);
  console.error(`      cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`);
  process.exit(1);
}

const outDir = dirname(OUT);
const nodeDir = outDir;
const webDir = join(outDir, "web");
execFileSync(bindgen, ["--target", "nodejs", "--out-dir", nodeDir, "--out-name", "xeet_wasm", artifact], { cwd: ROOT, stdio: "inherit" });
mkdirSync(webDir, { recursive: true });
execFileSync(bindgen, ["--target", "web", "--out-dir", webDir, "--out-name", "xeet_wasm", artifact], { cwd: ROOT, stdio: "inherit" });

// The Node glue is CommonJS; the package is `"type": "module"`, so the module
// directory needs its own package.json to be treated as CommonJS (otherwise
// `require()` of the glue fails with "exports is not defined in ES module
// scope").
writeFileSync(join(nodeDir, "package.json"), '{ "type": "commonjs" }\n');
// Turbopack rewrites `__dirname` in bundled workspace CJS files to `/ROOT/...`;
// map `/ROOT/...` back to `process.cwd()` so `@xeet/core/node` works inside
// Next.js App Router / Turbopack Route Handlers as well as plain Node.js.
{
  const nodeGluePath = join(nodeDir, "xeet_wasm.js");
  const glue = readFileSync(nodeGluePath, "utf8").replace(
    "const wasmPath = `${__dirname}/xeet_wasm_bg.wasm`;",
    "const wasmPath = require('path').join(__dirname.startsWith('/ROOT/') ? process.cwd() + __dirname.slice(5) : __dirname, 'xeet_wasm_bg.wasm');",
  );
  writeFileSync(nodeGluePath, glue);
}
// A stale artifact from an earlier layout would be picked up by the loader
// before the current one, so remove what this build no longer produces.
for (const stale of ["xeet_wasm.wasm"]) {
  try {
    unlinkSync(join(nodeDir, stale));
  } catch {}
}

// --- wasm-opt: opt-in -------------------------------------------------------
//
// Off by default, and it runs *after* wasm-bindgen when it is on. Both halves of
// that are deliberate:
//
// - Using it at all is a trade against build time. Binaryen has to parse and
//   re-emit the module's data segments, which are most of its tens of
//   megabytes, so the pass costs 8–15 s. The SIMD flag above is where the code
//   win comes from and it costs nothing extra, so it is the default;
//   `XEET_WASM_OPT=1` is for a shipping build that wants the smaller module.
// - Running before wasm-bindgen would be wrong: wasm-bindgen reads custom
//   sections it writes itself (`__wasm_bindgen_unstable`) and the
//   `target_features` section, and an optimizer that does not know about them
//   can drop them.
const OPT_FLAGS = [
  "-O2",
  "--enable-simd",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
];

/** The command, when `command --version` exits 0: how a tool is found on PATH. */
function findOnPath(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "pipe" });
    return command;
  } catch {
    return null;
  }
}

if (profile === "release" && process.env.XEET_WASM_OPT === "1") {
  const wasmOpt = findOnPath(process.env.WASM_OPT ?? "wasm-opt");
  if (!wasmOpt) {
    console.log("wasm: XEET_WASM_OPT=1 but wasm-opt is not on PATH; skipping the extra pass (WASM_OPT=<path> points at it)");
  } else {
    for (const dir of [nodeDir, webDir]) {
      const file = join(dir, "xeet_wasm_bg.wasm");
      const before = statSync(file).size;
      execFileSync(wasmOpt, [...OPT_FLAGS, file, "-o", file], { cwd: ROOT, stdio: "inherit" });
      console.log(`wasm: wasm-opt -O2 ${relative(ROOT, file)} (${(before / 1e6).toFixed(2)} → ${(statSync(file).size / 1e6).toFixed(2)} MB)`);
    }
  }
}

// The lazy packs live beside the module. `packs.json` carries a SHA-256 for
// each blob and each file, so the loader can verify what it fetched before
// registering it.
const packs = buildFontPacks();
// The browser loader is the same module Node uses; the web build copies it
// beside the glue so `/wasm/fonts.js` is one file in both dev and production.
cpSync(join(ROOT, "packages", "xeet", "src", "fonts.js"), join(webDir, "fonts.js"));
console.log(
  `fonts: ${(packs.totalBytes / 1e6).toFixed(2)} MB in ${Object.keys(packs.packs).length} lazy packs (${Object.keys(packs.packs).join(", ")})`,
);

const wasmFile = join(nodeDir, "xeet_wasm_bg.wasm");
const bytes = statSync(wasmFile).size;
const gz = gzipSync(readFileSync(wasmFile)).length;
console.log(`wasm: ${wasmFile} (${(bytes / 1e6).toFixed(2)} MB raw, ${(gz / 1e3).toFixed(0)} kB gzipped)`);
console.log(`wasm: glue for Node in ${nodeDir}, for browsers in ${webDir}`);
const glueSize = statSync(join(nodeDir, "xeet_wasm.js")).size;
console.log(`wasm: ${join(nodeDir, "xeet_wasm.js")} (${(glueSize / 1e3).toFixed(1)} kB)`);
