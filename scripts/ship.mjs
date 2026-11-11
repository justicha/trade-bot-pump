// Безопасный коммит + push: тесты -> проверка секретов -> commit -> push
//
// Логика проверок вынесена в экспортируемые функции (scripts/ship.test.mjs). Сам сценарий
// (npm test -> add -> проверки -> commit -> push) запускается ТОЛЬКО при прямом вызове
// `node scripts/ship.mjs ...`; импорт модуля ничего не делает.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Пути, которые никогда не должны попасть в коммит (добавленными, изменёнными или как новое имя
// при переименовании). Удаление такого файла — это НЕ утечка, его коммитить можно.
export const FORBIDDEN = [/(^|\/)\.env$/, /(^|\/)keys\//, /(^|\/)data\//, /test-output\.txt$/,
  /^agents\//, /^\.claude\//, /node_modules\//];

// Ключи в тексте: api-key= / api_key= (это один и тот же ключ Helius в URL) с длинным значением,
// кроме заглушек YOUR_... и test...; и PRIVATE_KEY = <длинное значение>.
// Группа 1 — имя, группа 2 — значение (его маскируем, целиком не печатаем никогда).
const LEAK_PATTERNS = [
  /(api[-_]key=)((?!YOUR_|test)[A-Za-z0-9-]{16,})/gi,
  /(PRIVATE_KEY\s*=\s*)(\S{20,})/g,
];

// Список запрещённых путей из переданных.
export function forbiddenPaths(paths) {
  return (paths ?? []).filter((f) => FORBIDDEN.some((r) => r.test(f)));
}

// Заголовок файла в diff: "+++ b/<путь>", "+++ /dev/null" (git может взять путь в кавычки).
// Добавленная строка кода, которая сама начинается с "++", заголовком НЕ считается — иначе это
// был бы способ спрятать ключ от проверки.
const ADDED_HEADER = /^\+\+\+ ("?[ab]\/|\/dev\/null)/;

// Только добавленные строки diff: начинаются с "+", кроме заголовка файла "+++ b/...".
// Удаляемые строки ("-...") ключом в коммите не являются: коммит их как раз убирает.
export function addedLines(diffText) {
  return String(diffText ?? "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !ADDED_HEADER.test(l));
}

// Маска: имя как есть, из значения — первые 4 символа и "***".
export function maskSecret(value) {
  return String(value).slice(0, 4) + "***";
}

// Совпадения с ключами в строках (обычно — результат addedLines). Возвращает ТОЛЬКО
// замаскированные значения: [{ match: "api-key=abcd***" }, ...]. Сам ключ не возвращается.
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

// Разбить `git diff` на куски по файлам: { "путь": "текст diff этого файла" }. Путь берётся из
// "+++ b/<путь>" (для удалённого файла — "+++ /dev/null", тогда из "--- a/<путь>").
// Заголовки "---"/"+++" распознаются только до первого "@@" файла: внутри хунка такие строки —
// это код, и они идут в проверку.
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

// Утечки по файлам: только добавленные строки. [{ file, match }].
export function findLeaksInDiff(diffText) {
  const res = [];
  for (const [file, chunk] of Object.entries(diffByFile(diffText))) {
    for (const l of findLeaks(addedLines(chunk))) res.push({ file, match: l.match });
  }
  return res;
}

const gitIn = (cwd) => (...a) => spawnSync("git", a, { encoding: "utf8", cwd });

// Что сейчас в индексе.
//   all     — все пути (включая удаления): для проверки «нечего коммитить»
//   checked — только Added/Copied/Modified/Renamed; для R git отдаёт НОВЫЙ путь
// -M: переименования распознаются явно, независимо от diff.renames в настройках пользователя.
export function stagedPaths(cwd = process.cwd()) {
  const git = gitIn(cwd);
  const list = (...extra) =>
    git("diff", "--cached", "-M", "--name-only", ...extra).stdout.split(/\r?\n/).filter(Boolean);
  return { all: list(), checked: list("--diff-filter=ACMR") };
}

// Список файлов коммита со статусом: [{ status: "A"|"M"|"D"|"R"|..., path, from? }].
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

// Diff индекса без контекста (для поиска ключей в добавленных строках).
export function stagedDiff(cwd = process.cwd()) {
  return gitIn(cwd)("diff", "--cached", "-M", "-U0").stdout;
}

function main() {
  const args = process.argv.slice(2);
  const allowMain = args.includes("--main");
  const msg = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  const git = gitIn(process.cwd());
  const die = (t) => { console.error("STOP: " + t); process.exit(1); };

  if (!msg) die('нужно сообщение: npm run ship -- "что изменил"');

  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (!branch) die("это не git-репозиторий");
  if (["main", "master"].includes(branch) && !allowMain)
    die(`ты на ${branch}. Создай ветку (git switch -c fix/xxx) или добавь --main`);

  console.log(`Ветка: ${branch}\nЗапускаю npm test ...`);
  const t = spawnSync("npm test", { stdio: "inherit", shell: true });
  if (t.status !== 0) die("npm test не зелёный, push отменён");

  git("add", "-A");
  const staged = stagedPaths();
  if (!staged.all.length) die("нечего коммитить");

  const bad = forbiddenPaths(staged.checked);
  const leaks = findLeaksInDiff(stagedDiff());
  if (bad.length || leaks.length) {
    git("reset");
    const why = [
      ...(bad.length ? ["пути: " + bad.join(", ")] : []),
      ...(leaks.length ? ["похоже на ключ: " + leaks.map((l) => `${l.file}: ${l.match}`).join("; ")] : []),
    ].join(" | ");
    die("в коммит попало запрещённое (" + why + "). Всё отменено, ничего не отправлено.");
  }

  const files = stagedStatus();
  console.log(`Файлов в коммите: ${files.length}`);
  for (const f of files) console.log(`  ${f.status}  ${f.from ? `${f.from} -> ${f.path}` : f.path}`);
  const c = git("commit", "-m", msg);
  if (c.status !== 0) die(c.stderr || c.stdout);
  const p = spawnSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
  if (p.status !== 0) die("push не прошёл (проверь вход в GitHub и git remote -v)");
  console.log("Готово: отправлено в origin/" + branch);
}

// Прямой вызов (`node scripts/ship.mjs`, `npm run ship`) — запускаем сценарий; импорт — нет.
// Пути сравниваются после resolve (на Windows — без учёта регистра: c:\ и C:\ — один путь).
function isMain() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) main();
