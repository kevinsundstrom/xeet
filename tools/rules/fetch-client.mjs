// Fetch X's shipped client JS for rule evidence (PLAN.md §3, §9).
//
// Logged out, low volume, one-time per app version. X's code is proprietary, so
// it lands in assets/vendor/ (git-ignored); only a lockfile of hashes is
// committed (assets/rules.lock.json).
//
//   node tools/rules/fetch-client.mjs            # crawl from the captured page
//   node tools/rules/fetch-client.mjs --refresh  # fetch x.com HTML first
//   node tools/rules/fetch-client.mjs --from assets/vendor/corpus/text-stripe.html
//                                                # pin the client a captured page used
//   node tools/rules/fetch-client.mjs --limit 50 # stop early (rough search)
//   node tools/rules/fetch-client.mjs --concurrency 2 --delay 200
//
// The entry bundle is parsed out of the captured post page
// (assets/vendor/upstream/probe.html), a fresh https://x.com/ fetch, or the
// `--from` page. Every reachable `./assets/*.js` and `assets/*.js` reference is
// then downloaded with a breadth-first crawl, sha256-pinned, and written under
// assets/vendor/upstream/js/<basename>. The lockfile keeps one snapshot per app
// version (`versions[appVersion]`), because the corpus spans more than one and
// rules can differ between them (SPEC.md §5.1); reruns only download new files.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UPSTREAM = join(ROOT, "assets/vendor/upstream");
const HTML_PATH = join(UPSTREAM, "probe.html");
const JS_DIR = join(UPSTREAM, "js");
const LOCK_PATH = join(ROOT, "assets/rules.lock.json");

const UA = "xeet-dev/0.1 (rule evidence, logged out; +https://github.com/rauchg/xeet)";
const BASE = "https://abs.twimg.com/x-web/x-web/";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const CONCURRENCY = Number(opt("concurrency", "3"));
const DELAY_MS = Number(opt("delay", "150"));
const LIMIT = Number(opt("limit", "100000"));
const REFRESH = flag("refresh");
// Pin the client a captured page was rendered with, instead of today's x.com:
//   node tools/rules/fetch-client.mjs --from assets/vendor/corpus/text-stripe.html
const FROM = opt("from", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function get(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
    if (res.status === 429 || res.status === 503) {
      const wait = 5000 * (attempt + 1);
      console.warn(`  ${res.status} from ${url}; waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`gave up on ${url}`);
}

async function entryFromHtml() {
  let html;
  if (FROM) {
    html = await readFile(FROM, "utf8");
  } else if (REFRESH || !existsSync(HTML_PATH)) {
    console.log("fetching https://x.com/ ...");
    html = (await get("https://x.com/")).toString("utf8");
    await mkdir(UPSTREAM, { recursive: true });
    await writeFile(join(UPSTREAM, "probe.html"), html);
  } else {
    html = await readFile(HTML_PATH, "utf8");
  }
  const entry = html.match(/entry-client-logged-out-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!entry) throw new Error("no entry-client-logged-out bundle in the captured page");
  const appVersion = html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? "unknown";
  const stylesheet = html.match(/assets\/styles-[A-Za-z0-9_-]+\.css/)?.[0] ?? null;
  return { entry, appVersion, stylesheet };
}

/** Chunk file names referenced by a bundle: static imports, dynamic imports, maps. */
function refsFrom(source) {
  const out = new Set();
  for (const m of source.matchAll(/["'`](?:\.\/)?(?:assets\/)?([A-Za-z0-9_-]{6,}\.js)["'`]/g)) out.add(m[1]);
  return out;
}

async function main() {
  await mkdir(JS_DIR, { recursive: true });
  const { entry, appVersion, stylesheet } = await entryFromHtml();
  console.log(`app ${appVersion}, entry ${entry}`);

  const lock = existsSync(LOCK_PATH)
    ? JSON.parse(await readFile(LOCK_PATH, "utf8"))
    : { comment: "Pins X's shipped client JS used as evidence for SPEC.md rules. Assets are not committed." };
  // Keep every snapshot we have evidence against: the corpus spans app versions
  // and a rule can differ between them (SPEC.md §5.1). `versions[appVersion]`
  // holds each snapshot; the top-level fields always describe
  // `currentAppVersion`, which only a run against today's x.com moves forward.
  lock.versions ??= {};
  lock.appVersions ??= [];
  const isNewVersion = !lock.appVersions.includes(appVersion);
  if (isNewVersion) lock.appVersions.push(appVersion);
  // "Current" is the newest version we know: a newly discovered one, or
  // whatever today's x.com serves. Pinning an old page with --from never moves
  // it backwards.
  if (isNewVersion || (!FROM && REFRESH) || !lock.currentAppVersion) lock.currentAppVersion = appVersion;
  const snapshot = (lock.versions[appVersion] ??= { entry, files: {} });
  snapshot.entry = entry;
  snapshot.files ??= {};
  // A chunk already downloaded for any snapshot is on disk with a pinned hash;
  // reuse that pin instead of fetching it again, but still record that this
  // version references it.
  const known = {};
  for (const other of Object.values(lock.versions)) Object.assign(known, other.files ?? {});
  lock.files = snapshot.files;
  lock.fetchedAt = new Date().toISOString();

  const queue = [entry];
  const seen = new Set(queue);
  let fetched = 0;
  let bytes = 0;

  const worker = async () => {
    for (;;) {
      const name = queue.shift();
      if (name === undefined || fetched >= LIMIT) return;
      const path = join(JS_DIR, name);
      let buf;
      if (existsSync(path)) {
        buf = await readFile(path);
        if (known[name] && known[name].sha256 === sha256(buf)) {
          // Already pinned for some version; still crawl its references.
          lock.files[name] = known[name];
          for (const r of refsFrom(buf.toString("utf8"))) if (!seen.has(r)) { seen.add(r); queue.push(r); }
          continue;
        }
      }
      try {
        buf = await get(`${BASE}${name === entry ? "" : "assets/"}${name}`);
      } catch (err) {
        console.warn(`  skip ${name}: ${err.message}`);
        continue;
      }
      fetched++;
      bytes += buf.length;
      await writeFile(path, buf);
      lock.files[name] = { sha256: sha256(buf), bytes: buf.length };
      for (const r of refsFrom(buf.toString("utf8"))) if (!seen.has(r)) { seen.add(r); queue.push(r); }
      if (fetched % 25 === 0) console.log(`  ${fetched} files, ${(bytes / 1048576).toFixed(1)} MB`);
      await sleep(DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  lock.versions[appVersion] = { entry, files: snapshot.files };
  const current = lock.versions[lock.currentAppVersion];
  lock.appVersion = lock.currentAppVersion;
  lock.entry = current.entry;
  lock.files = current.files;
  if (stylesheet && appVersion === lock.currentAppVersion) lock.stylesheet = stylesheet;
  lock.fileCount = Object.keys(current.files).length;
  lock.totalBytes = Object.values(current.files).reduce((a, f) => a + f.bytes, 0);
  lock.versionCount = Object.keys(lock.versions).length;
  lock.versionsSummary = Object.fromEntries(
    Object.entries(lock.versions).map(([v, snap]) => [
      v,
      { entry: snap.entry, files: Object.keys(snap.files ?? {}).length, bytes: Object.values(snap.files ?? {}).reduce((a, f) => a + f.bytes, 0) },
    ])
  );
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`current ${lock.appVersion}: ${lock.fileCount} files, ${(lock.totalBytes / 1048576).toFixed(1)} MB in ${relative(ROOT, JS_DIR)}`);
  console.log(`snapshots: ${Object.entries(lock.versionsSummary).map(([v, x]) => `${v.slice(0, 8)} (${x.files})`).join(", ")}`);
}

await main();
