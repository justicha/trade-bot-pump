import "./lib/test-env.mjs";
// scripts/ship.mjs: forbidden paths are checked only for added/modified/renamed
// files (deleting test-output.txt is not a leak), keys — only in added diff lines.
//
// The original logic checked the whole `git diff --cached --name-only` (with deletions) and the whole diff
// (with removed "-" lines), so a commit that DELETES test-output.txt was blocked.
//
// The ship scenario (npm test / commit / push) is NOT run here. All git operations run in a temp
// repository in os.tmpdir(): no remote, no network, an empty global config (independent of
// the developer's hooks, signature and autocrlf).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shipPath = path.join(here, "ship.mjs");
const ship = await import(pathToFileURL(shipPath).href);
const { forbiddenPaths, addedLines, findLeaks, findLeaksInDiff, diffByFile, stagedPaths, stagedStatus, stagedDiff, maskSecret } = ship;

// Keys are assembled in parts: the test source must not contain a line that looks like a key, otherwise
// ship would block the commit of the test itself.
const KEY = "Ab3dE" + "f9Hk2Lm7Np4Qr8St" + "Uv6Wx1Yz0aBcDeFg"; // 32 chars [A-Za-z0-9]
const API = "api" + "-key=";
const API_US = "api" + "_key=";
const PK = "PRIVATE" + "_KEY";

// ---------------------------------------------------------------------------------------------
// 1. Pure functions
// ---------------------------------------------------------------------------------------------
{
  const blocked = ["test-output.txt", ".env", "keys/x.json", "data/journal/a.jsonl", "agents/TASK.md", ".claude/s.json", "node_modules/x/y.js", "sub/.env", "sub/keys/a.json", "logs/test-output.txt"];
  const allowed = ["lib/a.mjs", "docs/env.md", ".env.example", "scripts/keys.mjs", "README.md"];
  assert.deepEqual(forbiddenPaths(blocked), blocked, "every forbidden pattern still blocks (list not narrowed)");
  assert.deepEqual(forbiddenPaths(allowed), [], "ordinary paths pass");
  assert.deepEqual(forbiddenPaths([]), []);
  assert.deepEqual(forbiddenPaths(undefined), []);
}
{
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
    " context",
    "+++also code: an added line whose text starts with ++",
  ].join("\n");
  assert.deepEqual(addedLines(diff), ["+new line", "+++also code: an added line whose text starts with ++"], "only added lines; the +++ b/ header is not code");
  assert.deepEqual(addedLines("+++ b/file\n+++ /dev/null\n+++ \"b/with space.txt\""), [], "file headers (plain, /dev/null, quoted) are not code");
  assert.deepEqual(addedLines(""), []);
}
{
  // a removed line with a key is NOT a leak; an added one is a leak
  assert.deepEqual(findLeaks(addedLines(`-url=https://x.invalid/?${API}${KEY}`)), [], "a removed line with a key is not a leak");
  const add = findLeaks(addedLines(`+url=https://x.invalid/?${API}${KEY}`));
  assert.equal(add.length, 1, "an added line with a key is a leak");
  assert.equal(add[0].match, `${API}${KEY.slice(0, 4)}***`, "masked: name + first 4 chars + ***");
  assert.ok(!JSON.stringify(add).includes(KEY), "the full key is never returned");
  assert.ok(!JSON.stringify(add).includes(KEY.slice(0, 5)), "not even 5 chars of the key");
  assert.deepEqual(findLeaks(addedLines(`+++ b/${API}${KEY}`)), [], "a +++ b/ header is not a code line");

  assert.equal(findLeaks([`+${API_US}${KEY}`]).length, 1, "api_key= (underscore) is caught too");
  assert.equal(findLeaks([`+HELIUS_API_KEY=${KEY}`]).length, 1, "upper-case API_KEY= is caught");
  assert.equal(findLeaks([`+${API}YOUR_${KEY}`]).length, 0, "YOUR_ placeholder is not a key");
  assert.equal(findLeaks([`+${API}test${KEY}`]).length, 0, "test... placeholder is not a key");
  assert.equal(findLeaks([`+${API}short123`]).length, 0, "a short value is not a key (unchanged threshold: 16)");
  const pk = findLeaks([`+${PK} = ${"5".repeat(10)}${KEY}`]);
  assert.equal(pk.length, 1, "PRIVATE_KEY = <long> is caught");
  assert.ok(pk[0].match.endsWith("5555***") && !JSON.stringify(pk).includes(KEY), "PRIVATE_KEY value masked");
  assert.equal(maskSecret("abcdefgh"), "abcd***");
}
{
  // per-file split: file name next to the masked match; deletions and headers ignored
  const diff = [
    "diff --git a/cfg.txt b/cfg.txt",
    "--- a/cfg.txt",
    "+++ b/cfg.txt",
    "@@ -1 +1 @@",
    `-old=${API}${KEY}`,
    "+old=removed",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    `-${API}${KEY}`,
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    `+++ hidden ${API_US}${KEY}`,
  ].join("\n");
  assert.deepEqual(Object.keys(diffByFile(diff)), ["cfg.txt", "gone.txt", "new.txt"]);
  const leaks = findLeaksInDiff(diff);
  assert.deepEqual(leaks, [{ file: "new.txt", match: `${API_US}${KEY.slice(0, 4)}***` }], "only the added key in new.txt, even on a line starting with ++");
}

// ---------------------------------------------------------------------------------------------
// 2. A temp git repository: the real git commands from ship.mjs
// ---------------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ship-test-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const emptyCfg = path.join(tmp, "gitconfig");
fs.writeFileSync(emptyCfg, "");
// Isolation from the developer's settings (hooks, signature, autocrlf, defaultBranch): an empty global
// config, the system one disabled. Also applies to the git that ship.mjs functions call.
process.env.GIT_CONFIG_GLOBAL = emptyCfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

const git = (...a) => {
  const r = spawnSync("git", ["-c", "user.name=ship-test", "-c", "user.email=ship-test@example.invalid", ...a], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const rm = (rel) => fs.rmSync(path.join(repo, rel));

git("init", "-q", "-b", "main");
assert.equal(git("remote").trim(), "", "the temp repo has no remote (nothing can be pushed)");

// --- deleting test-output.txt passes -----------------------------------------------------
write("README.md", "readme\n");
write("test-output.txt", "old log\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
rm("test-output.txt");
git("add", "-A");
{
  const s = stagedPaths(repo);
  assert.deepEqual(s.all, ["test-output.txt"], "the deletion is staged: there IS something to commit");
  assert.deepEqual(s.checked, [], "ACMR list is empty for a pure deletion");
  assert.deepEqual(forbiddenPaths(s.checked), [], "deleting test-output.txt is allowed");
  // The original logic: forbidden over the full list -> blocked. That was the bug.
  assert.deepEqual(forbiddenPaths(s.all), ["test-output.txt"], "(old logic would have blocked this commit)");
  assert.deepEqual(stagedStatus(repo), [{ status: "D", path: "test-output.txt" }], "status list shows D test-output.txt");
  assert.deepEqual(findLeaksInDiff(stagedDiff(repo)), [], "no leaks in a deletion");
}
git("commit", "-q", "-m", "remove log");

// --- adding forbidden files is blocked ---------------------------------------------
write("test-output.txt", "new log\n");
write(".env", "X=1\n");
write("keys/x.json", "[1,2,3]\n");
write("lib/ok.mjs", "export const ok = 1;\n");
git("add", "-A");
{
  const s = stagedPaths(repo);
  assert.deepEqual(forbiddenPaths(s.checked).sort(), [".env", "keys/x.json", "test-output.txt"], "test-output.txt, .env and keys/x.json are blocked");
  const st = stagedStatus(repo);
  assert.ok(st.every((f) => f.status === "A"), "all four are Added");
  assert.equal(st.length, 4);
}
git("reset", "-q");
for (const f of ["test-output.txt", ".env", "keys/x.json", "lib/ok.mjs"]) rm(f);

// --- an added line with a key is blocked; removing a key line is not ------------------
write("config.txt", `endpoint=https://rpc.invalid/?${API}${KEY}\n`);
git("add", "-A");
{
  const leaks = findLeaksInDiff(stagedDiff(repo));
  assert.equal(leaks.length, 1, "an added api-key=<32 chars> line is blocked");
  assert.equal(leaks[0].file, "config.txt");
  assert.equal(leaks[0].match, `${API}${KEY.slice(0, 4)}***`);
  assert.ok(!JSON.stringify(leaks).includes(KEY), "the key is never in the result");
}
git("commit", "-q", "-m", "a key that was committed before (temp repo only)");
write("config.txt", "endpoint=https://rpc.invalid/\n");
git("add", "-A");
{
  assert.deepEqual(findLeaksInDiff(stagedDiff(repo)), [], "removing a key line (the fix) is not a leak");
  assert.deepEqual(stagedStatus(repo), [{ status: "M", path: "config.txt" }]);
}
git("commit", "-q", "-m", "drop key");

// --- rename: the NEW path is checked ---------------------------------------------------
write("notes.txt", "some notes that are long enough to be detected as a rename\n");
write("data/old.txt", "old data file content, long enough for rename detection\n");
git("add", "-A");
git("commit", "-q", "-m", "files to rename");
// git mv does not create the destination directory
for (const d of ["keys", "docs"]) fs.mkdirSync(path.join(repo, d), { recursive: true });
git("mv", "notes.txt", "keys/notes.txt"); // allowed -> forbidden
git("mv", "data/old.txt", "docs/old.txt"); // forbidden -> allowed
{
  const s = stagedPaths(repo);
  assert.deepEqual(s.checked.sort(), ["docs/old.txt", "keys/notes.txt"], "--name-only gives the NEW path of a rename");
  assert.deepEqual(forbiddenPaths(s.checked), ["keys/notes.txt"], "renaming INTO keys/ is blocked, renaming OUT of data/ is not");
  const st = stagedStatus(repo).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(st, [
    { status: "R", from: "data/old.txt", path: "docs/old.txt" },
    { status: "R", from: "notes.txt", path: "keys/notes.txt" },
  ], "status list shows R old -> new");
}
git("reset", "-q");

// --- nothing to commit ------------------------------------------------------------------------
git("checkout", "-q", "--", ".");
git("clean", "-qfd");
assert.deepEqual(stagedPaths(repo).all, [], "empty index -> nothing to commit");

// ---------------------------------------------------------------------------------------------
// 3. Importing the module runs nothing (no npm test, no git). cwd is a temp repository, so
//    even an error in a check could not touch the real one.
// ---------------------------------------------------------------------------------------------
{
  const head = git("rev-parse", "HEAD").trim();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(shipPath).href)});`], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, `import exits 0 (stderr: ${r.stderr})`);
  assert.equal(r.stdout.trim(), "", "import prints nothing (no 'Branch', no npm test)");
  assert.ok(!/STOP/.test(r.stderr), "import does not reach the CLI checks");
  assert.equal(git("rev-parse", "HEAD").trim(), head, "no commit was made");
  assert.equal(git("status", "--porcelain").trim(), "", "the index and the working tree are untouched");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ pureCases: "ok", tempRepo: "ok", importIsInert: true }));
console.log("PASS: ship blocks only added/changed/renamed forbidden paths and keys in added lines; deletions pass");
