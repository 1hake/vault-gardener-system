#!/usr/bin/env node
// gardener.js — snapshot vault, hand to Claude Code with the philosophy, commit result.

import { readFile, readdir, stat } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
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
const MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 20;

const die = (msg) => { console.error(`gardener: ${msg}`); process.exit(1); };
const readOr = async (p, fb = "") => { try { return await readFile(p, "utf8"); } catch { return fb; } };
const notify = (msg) => {
  if (process.platform !== "darwin") return;
  const safe = String(msg).replace(/["\\]/g, "");
  execFile("osascript", ["-e", `display notification "${safe}" with title "Gardener"`], () => {});
};

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

  const lines = [];
  for (const f of changed) {
    const abs = path.join(vault, f.file);
    let exists = true;
    try { await stat(abs); } catch { exists = false; }
    const stats = exists ? `+${f.insertions}/-${f.deletions}` : "supprimé";
    lines.push(`- ${f.file} (${stats})`);
  }
  return { base: base.slice(0, 7), count: changed.length, list: lines.join("\n") };
}

function summarizeTool(name, input) {
  if (name === "Read" || name === "Write" || name === "Edit") return input?.file_path || "";
  if (name === "Bash") return (input?.command || "").replace(/\s+/g, " ").slice(0, 80);
  return "";
}

function runClaude(prompt, vault) {
  const t0 = Date.now();
  const child = spawn(
    "claude",
    [
      "-p", prompt,
      "--allowedTools", "Read,Write,Edit,Bash",
      "--output-format", "stream-json",
      "--verbose",
      "--model", MODEL,
      "--max-turns", String(MAX_TURNS),
    ],
    { cwd: vault, stdio: ["ignore", "pipe", "inherit"] }
  );
  let buf = "";
  const el = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`.padEnd(8);
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === "assistant" && evt.message?.content) {
        for (const c of evt.message.content) {
          if (c.type === "tool_use") {
            process.stdout.write(`${el()} ${c.name.padEnd(5)} ${summarizeTool(c.name, c.input)}\n`);
          } else if (c.type === "text" && c.text?.trim()) {
            const line = c.text.trim().split("\n")[0].slice(0, 100);
            process.stdout.write(`${el()} text  ${line}\n`);
          }
        }
      } else if (evt.type === "result") {
        const u = evt.usage || {};
        const tokens = u.input_tokens != null
          ? ` | ${u.input_tokens} in / ${u.output_tokens} out tokens`
          : "";
        process.stdout.write(`${el()} done  ${evt.num_turns} turns${tokens}\n`);
      }
    }
  });
  return new Promise((r) => child.on("exit", (c) => r(c ?? 0)));
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
${diff.list || "(aucun fichier .md modifié)"}

# === INSTRUCTIONS ===

La liste ci-dessus ne contient que les noms et stats des fichiers modifiés — pas leur contenu. **Tu DOIS commencer par Read chacun de ces fichiers** pour voir ce que l'humain a écrit avant de décider quoi faire. Pour les fichiers inchangés que tu juges utile d'inspecter, utilise aussi Read à la demande.

Suis le rituel de la philosophie. À la fin, ajoute une entrée en bas de _gardener/log.md avec ce format EXACT :

## ${stamp} — <TL;DR en une ligne>

- <bullet : action + raison>
- ...

Le timestamp vient de CURRENT DATE tronqué à la minute : il garantit l'ordre chronologique et l'unicité de chaque run (plus de compteur manuel "run 2"). La TL;DR tient sur UNE ligne et permet de scanner le log à l'échelle. Si rien à faire : TL;DR = "aucune action — rien n'était mûr" + un bullet expliquant pourquoi.

cwd = vault root. L'inaction est un résultat valide.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const arg = args.find((a) => !a.startsWith("--")) || process.env.VAULT_PATH;
  if (!arg) die("usage: gardener.js <vault-path> [--dry]");
  const vault = path.resolve(arg);
  try { await stat(vault); } catch { die(`vault not found: ${vault}`); }

  const git = simpleGit(vault);
  if (!(await git.checkIsRepo())) die(`vault is not a git repo: ${vault}`);

  const now = new Date().toISOString();
  const status = await git.status();
  if (!status.isClean()) {
    if (dry) {
      console.log(`gardener: [dry] ${status.files.length} uncommitted files — pre-snapshot skipped`);
    } else {
      await git.add(".");
      await git.commit(`pre-gardener snapshot ${now}`);
      console.log(`gardener: pre-run snapshot (${status.files.length} files)`);
    }
  }

  const philosophy = await readOr(path.join(vault, "_gardener", "philosophy.md"));
  if (!philosophy) die("missing _gardener/philosophy.md");

  const tree = (await walk(vault)).join("\n");
  const diff = await humanChanges(git, vault);
  const logTail = tailLog(await readOr(path.join(vault, "_gardener", "log.md")));
  const openDialogue = await readOr(path.join(vault, "_gardener", "dialogue", "open.md"));
  const prompt = buildPrompt({ philosophy, tree, diff, logTail, openDialogue, now });

  console.log(`gardener: launching claude (${prompt.length} chars, model=${MODEL}${dry ? ", DRY" : ""})…\n`);
  const code = await runClaude(prompt, vault);
  if (code !== 0) die(`claude exited with code ${code}`);

  const after = await git.status();
  if (after.isClean()) {
    console.log("\ngardener: no changes.");
    notify("Run terminé — aucun changement");
    return;
  }
  if (dry) {
    console.log(`\ngardener: [dry] ${after.files.length} files changed — commit skipped. Run \`git diff\` or \`git checkout -- .\` to inspect/revert.`);
    notify(`[dry] ${after.files.length} fichiers modifiés — à inspecter`);
    return;
  }
  await git.add(".");
  await git.commit(`gardener run ${now}`);
  console.log(`\ngardener: committed ${after.files.length} files.`);
  notify(`Run terminé — ${after.files.length} fichiers modifiés`);
}

main().catch((e) => die(e.stack || e.message));
