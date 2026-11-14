#!/usr/bin/env node
// Vercel CI test gate + production static/WASM builder.
//
// Runs on every deployment and pull request on Vercel (`vercel.json`
// `buildCommand`):
//   1. Bootstraps Rust (`wasm32-unknown-unknown`) + prebuilt `wasm-bindgen`
//      into `node_modules/.cache/xeet-ci/` (cached across Vercel builds).
//   2. Runs the CI verification gates: contract, unsafe, golden stamps, full
//      Rust workspace test suite (`cargo test --profile fast --workspace`),
//      WASM compilation, and Node/API integration tests. Any failure aborts
//      the build and fails the Vercel CI check.
//   3. Writes `dist/` (`web/` + `dist/wasm/` browser WebAssembly bundle).

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WASM_BINDGEN_VERSION = "0.2.130";
const IS_VERCEL = process.env.VERCEL === "1";
const SKIP_TESTS = process.argv.includes("--skip-tests");

const CACHE_DIR = join(ROOT, "node_modules", ".cache", "xeet-ci");
const BIN_DIR = join(CACHE_DIR, "bin");
const RUSTUP_HOME = process.env.RUSTUP_HOME ?? (IS_VERCEL ? join(CACHE_DIR, "rustup") : join(homedir(), ".rustup"));
const CARGO_HOME = process.env.CARGO_HOME ?? (IS_VERCEL ? join(CACHE_DIR, "cargo") : join(homedir(), ".cargo"));

mkdirSync(BIN_DIR, { recursive: true });

function buildEnv() {
  const extraPaths = [BIN_DIR, join(CARGO_HOME, "bin")];
  // Also prepend active rustup toolchain bin if present so Homebrew cargo never shadows it.
  try {
    const out = execFileSync("rustup", ["toolchain", "list", "-v"], {
      encoding: "utf8",
      env: { ...process.env, RUSTUP_HOME, CARGO_HOME, PATH: `${extraPaths.join(":")}:${process.env.PATH ?? ""}` },
    });
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s+.*?(\/\S+)\s*$/);
      if (m && existsSync(join(m[2], "bin", "cargo"))) {
        extraPaths.unshift(join(m[2], "bin"));
        break;
      }
    }
  } catch {}
  return {
    ...process.env,
    RUSTUP_HOME,
    CARGO_HOME,
    PATH: `${extraPaths.join(":")}:${process.env.PATH ?? ""}`,
    CARGO_TERM_COLOR: "always",
    ...(IS_VERCEL
      ? {
          CARGO_TARGET_DIR: join(CACHE_DIR, "target"),
          XEET_WASM_TARGET_DIR: join(CACHE_DIR, "wasm-target"),
        }
      : {}),
  };
}

function hasCommand(cmd, args, env) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", env });
    return true;
  } catch {
    return false;
  }
}

function ensureRust(env) {
  const hasCargo = hasCommand("cargo", ["--version"], env);
  let hasWasmTarget = false;
  if (hasCargo) {
    try {
      const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8", env }).trim();
      hasWasmTarget = existsSync(join(sysroot, "lib", "rustlib", "wasm32-unknown-unknown", "lib"));
    } catch {}
  }
  if (hasCargo && hasWasmTarget) return buildEnv();

  if (!hasCargo) {
    console.log("ci: installing minimal Rust stable + wasm32-unknown-unknown into build cache…");
    execSync(
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --target wasm32-unknown-unknown --no-modify-path",
      { stdio: "inherit", env },
    );
  } else {
    console.log("ci: adding wasm32-unknown-unknown target…");
    execFileSync("rustup", ["target", "add", "wasm32-unknown-unknown"], { stdio: "inherit", env });
  }
  return buildEnv();
}

function wasmBindgenTriple() {
  const os = platform();
  const cpu = arch();
  if (os === "linux" && cpu === "x64") return "x86_64-unknown-linux-musl";
  if (os === "linux" && cpu === "arm64") return "aarch64-unknown-linux-gnu";
  if (os === "darwin" && cpu === "arm64") return "aarch64-apple-darwin";
  if (os === "darwin" && cpu === "x64") return "x86_64-apple-darwin";
  throw new Error(`unsupported platform for prebuilt wasm-bindgen: ${os}/${cpu}`);
}

function ensureWasmBindgen(env) {
  for (const candidate of ["wasm-bindgen", join(BIN_DIR, "wasm-bindgen"), join(CARGO_HOME, "bin", "wasm-bindgen")]) {
    try {
      const v = execFileSync(candidate, ["--version"], { encoding: "utf8", env }).trim().split(" ").pop();
      if (v === WASM_BINDGEN_VERSION) {
        env.WASM_BINDGEN = candidate;
        return;
      }
    } catch {}
  }
  const triple = wasmBindgenTriple();
  const slug = `wasm-bindgen-${WASM_BINDGEN_VERSION}-${triple}`;
  const url = `https://github.com/rustwasm/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${slug}.tar.gz`;
  console.log(`ci: fetching prebuilt ${slug}…`);
  execSync(`curl -fsSL "${url}" | tar -xz -C "${BIN_DIR}" --strip-components=1 "${slug}/wasm-bindgen"`, {
    stdio: "inherit",
    env,
  });
  env.WASM_BINDGEN = join(BIN_DIR, "wasm-bindgen");
}

function step(label, fn) {
  const t0 = Date.now();
  console.log(`\n── ${label} ──`);
  fn();
  console.log(`✓ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// `--only <stage>` runs one stage; turbo.json runs each as its own cached task,
// so a deploy that changed only web/ restores the module and skips Rust
// entirely. Without `--only`, every stage runs in order (a local full build).
const STAGES = ["gates", "rust-test", "wasm", "pkg-test", "site"];
const onlyAt = process.argv.indexOf("--only");
const ONLY = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
if (ONLY && !STAGES.includes(ONLY)) {
  console.error(`unknown stage ${ONLY}; expected one of ${STAGES.join(", ")}`);
  process.exit(2);
}
const runs = (stage) => (ONLY ? ONLY === stage : !(SKIP_TESTS && ["gates", "rust-test", "pkg-test"].includes(stage)));

let env = buildEnv();
/**
 * Turbo runs the rust-test and wasm stages in parallel, and on a fresh cache
 * both would install the toolchain into the same directory at once. A
 * directory is created atomically, so it serves as the lock: one stage
 * installs, the other waits and then finds it installed.
 */
function withToolchainLock(fn) {
  const lock = join(CACHE_DIR, "toolchain.lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A lock older than 15 minutes is from a killed build.
      if (Date.now() - statSync(lock).mtimeMs > 15 * 60_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 15 * 60_000) throw new Error("timed out waiting for the toolchain lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Only the stages that compile Rust need the toolchain.
if (runs("rust-test") || runs("wasm")) {
  env = withToolchainLock(() => {
    const next = ensureRust(env);
    ensureWasmBindgen(next);
    return next;
  });
}

if (runs("gates")) {
  step("Contract, unsafe & golden-stamp gates", () => {
    execFileSync("node", ["tools/ship/check-contract.mjs"], { cwd: ROOT, stdio: "inherit", env });
    execFileSync("node", ["tools/ship/check-unsafe.mjs"], { cwd: ROOT, stdio: "inherit", env });
    execFileSync("node", ["tools/ship/golden-stamp.mjs", "--check"], { cwd: ROOT, stdio: "inherit", env });
  });
}

if (runs("rust-test")) {
  step("Rust workspace test suite (xeet-core, xeet-text, xeet-resolve, xeet-wasm, iconic_posts)", () => {
    execFileSync("cargo", ["test", "--profile", "fast", "--workspace"], {
      cwd: ROOT,
      stdio: "inherit",
      env,
    });
  });
}

const nodeWasm = join(ROOT, "packages", "xeet", "wasm", "xeet_wasm_bg.wasm");
const webWasm = join(ROOT, "packages", "xeet", "wasm", "web", "xeet_wasm_bg.wasm");
const wasmMissing = !existsSync(nodeWasm) || !existsSync(webWasm);
if (ONLY === "wasm" || (!ONLY && (!SKIP_TESTS || wasmMissing))) {
  step("Build Node + browser WebAssembly modules", () => {
    execFileSync("node", ["tools/ship/build-wasm.mjs"], { cwd: ROOT, stdio: "inherit", env });
  });
}

if (runs("pkg-test")) {
  step("WASM package tests", () => {
    execFileSync("node", ["--test", "packages/xeet/test/xeet.test.js", "packages/xeet/test/fonts.test.js"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...env, XEET_REQUIRE_WASM: "1" },
    });
  });
}

if (!runs("site") && ONLY !== "stage-wasm") process.exit(0);
if (wasmMissing && !existsSync(nodeWasm)) {
  console.error("site: the WebAssembly module is missing; run the wasm stage first");
  process.exit(1);
}

step("Stage /wasm/<hash> bundle for Next.js App Router", () => {
  const pubWasmRoot = join(ROOT, "public", "wasm");
  rmSync(pubWasmRoot, { recursive: true, force: true });

  const files = ["xeet_wasm.js", "xeet_wasm_bg.wasm"];
  const fontsDir = join(ROOT, "packages", "xeet", "wasm", "fonts");
  const fontFiles = readdirSync(fontsDir).sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(readFileSync(join(ROOT, "packages", "xeet", "wasm", "web", f)));
  for (const f of fontFiles) hash.update(readFileSync(join(fontsDir, f)));
  const wasmDir = `/wasm/${hash.digest("hex").slice(0, 16)}`;

  const dest = join(ROOT, "public", wasmDir);
  mkdirSync(join(dest, "fonts"), { recursive: true });
  for (const f of files) cpSync(join(ROOT, "packages", "xeet", "wasm", "web", f), join(dest, f));
  for (const f of fontFiles) cpSync(join(fontsDir, f), join(dest, "fonts", f));

  const wasmBytes = statSync(join(dest, "xeet_wasm_bg.wasm")).size;
  mkdirSync(join(ROOT, "app", "_generated"), { recursive: true });
  writeFileSync(
    join(ROOT, "app", "_generated", "wasm-manifest.js"),
    `// Auto-generated by tools/ship/vercel-build.mjs\nexport const WASM_DIR = ${JSON.stringify(wasmDir)};\nexport const WASM_BYTES = ${wasmBytes};\n`,
  );

  const fontBytes = fontFiles.reduce((n, f) => n + statSync(join(fontsDir, f)).size, 0);
  console.log(`staged ${wasmDir}/ (wasm ${(wasmBytes / 1e6).toFixed(2)} MB, lazy fonts ${(fontBytes / 1e6).toFixed(2)} MB)`);
});

if (ONLY === "stage-wasm") process.exit(0);

step("Build Next.js App Router site", () => {
  const nextBin = join(ROOT, "node_modules", ".bin", "next");
  execFileSync(nextBin, ["build"], { cwd: ROOT, stdio: "inherit", env });
});
