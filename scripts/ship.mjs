// Safe commit + push: tests -> secret check -> commit -> push
//
// The check logic lives in exported functions (scripts/ship.test.mjs). The scenario itself
// (npm test -> add -> checks -> commit -> push) runs ONLY on direct invocation
// `node scripts/ship.mjs ...`; importing the module does nothing.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Paths that must never get into a commit (added, modified, or as a new name
// on rename). Deleting such a file is NOT a leak; committing the deletion is fine.
export const FORBIDDEN = [/(^|\/)\.env$/, /(^|\/)keys\//, /(^|\/)data\//, /test-output\.txt$/,
  /^agents\//, /^\.claude\//, /node_modules\//];

// Keys in text: api-key= / api_key= (the same Helius key in the URL) with a long value,
// except the YOUR_... and test... placeholders; and PRIVATE_KEY = <long value>.
// Group 1 — the name, group 2 — the value (masked; the full value is never printed).
const LEAK_PATTERNS = [
  /(api[-_]key=)((?!YOUR_|test)[A-Za-z0-9-]{16,})/gi,
  /(PRIVATE_KEY\s*=\s*)(\S{20,})/g,
];

// The forbidden paths among the given ones.
export function forbiddenPaths(paths) {
  return (paths ?? []).filter((f) => FORBIDDEN.some((r) => r.test(f)));
}

// File header in a diff: "+++ b/<path>", "+++ /dev/null" (git may quote the path).
// An added code line that itself starts with "++" is NOT a header — otherwise that
// would be a way to hide a key from the check.
const ADDED_HEADER = /^\+\+\+ ("?[ab]\/|\/dev\/null)/;

// Only added diff lines: start with "+", except the "+++ b/..." file header.
// Removed lines ("-...") are not a key in the commit: the commit removes them.
export function addedLines(diffText) {
  return String(diffText ?? "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !ADDED_HEADER.test(l));
}

// Mask: the name as-is, from the value — the first 4 chars and "***".
export function maskSecret(value) {
  return String(value).slice(0, 4) + "***";
}

// Key matches in lines (usually the result of addedLines). Returns ONLY
// masked values: [{ match: "api-key=abcd***" }, ...]. The key itself is never returned.
export function findLeaks(lines) {
  const found = [];
  for (const line of lines ?? []) {
    for (const re of LEAK_PATTERNS) {
      re.lastIndex = 0;
      for (const m of String(line).matchAll(re)) found.push({ match: m[1] + maskSecret(m[2]) });
    }
  }
  return found;
}

// Split `git diff` into per-file chunks: { "path": "this file's diff text" }. The path comes from
// "+++ b/<path>" (for a deleted file — "+++ /dev/null", then from "--- a/<path>").
// The "---"/"+++" headers are recognized only before a file's first "@@": inside a hunk those lines
// are code, and they go to the check.
export function diffByFile(diffText) {
  const out = {};
  let cur = null;
  let oldPath = null;
  let inHeader = false;
  const unq = (p) => p.replace(/^"(.*)"$/, "$1");
  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      cur = null;
      oldPath = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith("--- ")) {
      oldPath = line === "--- /dev/null" ? null : unq(line.slice(4)).replace(/^a\//, "");
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      cur = line === "+++ /dev/null" ? oldPath ?? "(unknown)" : unq(line.slice(4)).replace(/^b\//, "");
      out[cur] ??= "";
      continue;
    }
    if (line.startsWith("@@")) inHeader = false;
    if (cur !== null) out[cur] += line + "\n";
  }
  return out;
}

// Leaks per file: only added lines. [{ file, match }].
export function findLeaksInDiff(diffText) {
  const res = [];
  for (const [file, chunk] of Object.entries(diffByFile(diffText))) {
    for (const l of findLeaks(addedLines(chunk))) res.push({ file, match: l.match });
  }
  return res;
}

const gitIn = (cwd) => (...a) => spawnSync("git", a, { encoding: "utf8", cwd });

// What is in the index right now.
//   all     — all paths (including deletions): for the "nothing to commit" check
//   checked — only Added/Copied/Modified/Renamed; for R git returns the NEW path
// -M: renames are recognized explicitly, regardless of diff.renames in the user's config.
export function stagedPaths(cwd = process.cwd()) {
  const git = gitIn(cwd);
  const list = (...extra) =>
    git("diff", "--cached", "-M", "--name-only", ...extra).stdout.split(/\r?\n/).filter(Boolean);
  return { all: list(), checked: list("--diff-filter=ACMR") };
}

// The commit's file list with status: [{ status: "A"|"M"|"D"|"R"|..., path, from? }].
export function stagedStatus(cwd = process.cwd()) {
  const out = gitIn(cwd)("diff", "--cached", "-M", "--name-status").stdout;
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [code, a, b] = line.split("\t");
      const status = code[0];
      return status === "R" || status === "C" ? { status, from: a, path: b } : { status, path: a };
    });
}

// The index diff without context (to find keys in added lines).
export function stagedDiff(cwd = process.cwd()) {
  return gitIn(cwd)("diff", "--cached", "-M", "-U0").stdout;
}

function main() {
  const args = process.argv.slice(2);
  const allowMain = args.includes("--main");
  const msg = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  const git = gitIn(process.cwd());
  const die = (t) => { console.error("STOP: " + t); process.exit(1); };

  if (!msg) die('need a message: npm run ship -- "what changed"');

  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (!branch) die("this is not a git repository");
  if (["main", "master"].includes(branch) && !allowMain)
    die(`you are on ${branch}. Create a branch (git switch -c fix/xxx) or add --main`);

  console.log(`Branch: ${branch}\nRunning npm test ...`);
  const t = spawnSync("npm test", { stdio: "inherit", shell: true });
  if (t.status !== 0) die("npm test is not green, push cancelled");

  git("add", "-A");
  const staged = stagedPaths();
  if (!staged.all.length) die("nothing to commit");

  const bad = forbiddenPaths(staged.checked);
  const leaks = findLeaksInDiff(stagedDiff());
  if (bad.length || leaks.length) {
    git("reset");
    const why = [
      ...(bad.length ? ["paths: " + bad.join(", ")] : []),
      ...(leaks.length ? ["looks like a key: " + leaks.map((l) => `${l.file}: ${l.match}`).join("; ")] : []),
    ].join(" | ");
    die("the commit contains forbidden files (" + why + "). Everything cancelled, nothing sent.");
  }

  const files = stagedStatus();
  console.log(`Files in the commit: ${files.length}`);
  for (const f of files) console.log(`  ${f.status}  ${f.from ? `${f.from} -> ${f.path}` : f.path}`);
  const c = git("commit", "-m", msg);
  if (c.status !== 0) die(c.stderr || c.stdout);
  const p = spawnSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
  if (p.status !== 0) die("push failed (check your GitHub login and git remote -v)");
  console.log("Done: pushed to origin/" + branch);
}

// A direct call (`node scripts/ship.mjs`, `npm run ship`) runs the scenario; an import does not.
// Paths are compared after resolve (on Windows — case-insensitively: c:\ and C:\ are one path).
function isMain() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) main();
