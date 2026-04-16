#!/usr/bin/env node
// gardener.js — snapshot vault, hand to Claude Code with the philosophy, commit result.

import { readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import simpleGit from "simple-git";

const SKIP = new Set([".git", ".obsidian", "_archive", "node_modules"]);
const SEPARATE = new Set([
  "_gardener/philosophy.md",
  "_gardener/log.md",
  "_gardener/dialogue/open.md",
]);
const MAX_BYTES = 50_000;
const LOG_TAIL = 20;

const die = (msg) => { console.error(`gardener: ${msg}`); process.exit(1); };
const readOr = async (p, fb = "") => { try { return await readFile(p, "utf8"); } catch { return fb; } };

async function walk(root, rel = "") {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    if (e.name.startsWith(".") && e.name !== ".gitignore") continue;
    const rp = path.join(rel, e.name);
    if (e.isDirectory()) { out.push(rp + "/"); out.push(...await walk(root, rp)); }
    else if (e.isFile()) out.push(rp);
  }
  return out;
}

async function humanChanges(git, vault) {
  const log = await git.log({ maxCount: 50 });
  const lastRun = log.all.find((c) => c.message.startsWith("gardener run"));
  const base = lastRun?.hash || (await git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim();
  const summary = await git.diffSummary([base, "HEAD"]);
  const changed = summary.files.filter((f) => f.file.endsWith(".md") && !SEPARATE.has(f.file));

  const bodies = [];
  for (const f of changed) {
    const abs = path.join(vault, f.file);
    try {
      const s = await stat(abs);
      if (s.size > MAX_BYTES) { bodies.push(`--- ${f.file} (${s.size} bytes, skipped) ---`); continue; }
      bodies.push(`--- ${f.file} (+${f.insertions}/-${f.deletions}) ---\n${await readFile(abs, "utf8")}`);
    } catch {
      bodies.push(`--- ${f.file} (supprimé) ---`);
    }
  }
  return { base: base.slice(0, 7), count: changed.length, contents: bodies.join("\n\n") };
}

function tailLog(body) {
  const sections = body.split(/\n(?=##\s)/);
  return sections.length > LOG_TAIL + 1
    ? [sections[0], ...sections.slice(-LOG_TAIL)].join("\n")
    : body;
}

function buildPrompt({ philosophy, tree, diff, logTail, openDialogue, now }) {
  const stamp = now.slice(0, 16).replace("T", " ");
  const diffHeader = diff.count === 0
    ? `(aucun changement humain depuis ${diff.base})`
    : `(${diff.count} fichier(s) .md modifiés depuis ${diff.base})`;
  return `You are the vault gardener. Reread your constitution, then act on the current vault.

# === PHILOSOPHY ===
${philosophy}

# === CURRENT DATE ===
${now}

# === VAULT TREE ===
${tree}

# === RECENT LOG ENTRIES ===
${logTail || "(empty — first run)"}

# === OPEN DIALOGUE ===
${openDialogue || "(empty)"}

# === CHANGES SINCE LAST GARDENER RUN ${diffHeader} ===
${diff.contents || "(rien à inspecter)"}

# === INSTRUCTIONS ===

Seuls les fichiers changés depuis le dernier run sont inclus ci-dessus (contenu complet post-changement). Pour les fichiers inchangés, utilise l'outil Read à la demande si tu as besoin d'inspecter leur contenu.

Suis le rituel de la philosophie. À la fin, ajoute une entrée en bas de _gardener/log.md avec ce format EXACT :

## ${stamp} — <TL;DR en une ligne>

- <bullet : action + raison>
- ...

Le timestamp vient de CURRENT DATE tronqué à la minute : il garantit l'ordre chronologique et l'unicité de chaque run (plus de compteur manuel "run 2"). La TL;DR tient sur UNE ligne et permet de scanner le log à l'échelle. Si rien à faire : TL;DR = "aucune action — rien n'était mûr" + un bullet expliquant pourquoi.

cwd = vault root. L'inaction est un résultat valide.
`;
}

async function main() {
  const arg = process.argv[2] || process.env.VAULT_PATH;
  if (!arg) die("usage: gardener.js <vault-path>");
  const vault = path.resolve(arg);
  try { await stat(vault); } catch { die(`vault not found: ${vault}`); }

  const git = simpleGit(vault);
  if (!(await git.checkIsRepo())) die(`vault is not a git repo: ${vault}`);

  const now = new Date().toISOString();
  const status = await git.status();
  if (!status.isClean()) {
    await git.add(".");
    await git.commit(`pre-gardener snapshot ${now}`);
    console.log(`gardener: pre-run snapshot (${status.files.length} files)`);
  }

  const philosophy = await readOr(path.join(vault, "_gardener", "philosophy.md"));
  if (!philosophy) die("missing _gardener/philosophy.md");

  const tree = (await walk(vault)).join("\n");
  const diff = await humanChanges(git, vault);
  const logTail = tailLog(await readOr(path.join(vault, "_gardener", "log.md")));
  const openDialogue = await readOr(path.join(vault, "_gardener", "dialogue", "open.md"));
  const prompt = buildPrompt({ philosophy, tree, diff, logTail, openDialogue, now });

  console.log(`gardener: launching claude (${prompt.length} chars)…\n`);
  const code = await new Promise((r) => {
    spawn("claude", ["-p", prompt, "--allowedTools", "Read,Write,Edit,Bash"],
      { cwd: vault, stdio: ["ignore", "inherit", "inherit"] }).on("exit", (c) => r(c ?? 0));
  });
  if (code !== 0) die(`claude exited with code ${code}`);

  const after = await git.status();
  if (after.isClean()) { console.log("\ngardener: no changes."); return; }
  await git.add(".");
  await git.commit(`gardener run ${now}`);
  console.log(`\ngardener: committed ${after.files.length} files.`);
}

main().catch((e) => die(e.stack || e.message));
