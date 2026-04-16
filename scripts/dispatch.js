#!/usr/bin/env node
// dispatch.js — parse @agent:live / @agent:bg tasks from a markdown note
// and fire them off. Live tasks open in iTerm; bg tasks run via `claude -p`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import matter from "gray-matter";
import PQueue from "p-queue";

const LIVE_BG_RE = /^(\s*)- \[ \] @agent:(live|bg)(?:\[([^\]]*)\])?\s+(.+?)\s*$/;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return process.env.HOME;
  if (p.startsWith("~/")) return path.join(process.env.HOME, p.slice(2));
  return p;
}

function die(msg) {
  console.error(`dispatch: ${msg}`);
  process.exit(1);
}

function slug(s, n = 30) {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

async function parseNote(filePath) {
  const raw = await readFile(filePath, "utf8");
  const { data, content } = matter(raw);
  if (!data.repo) die(`note ${filePath} has no 'repo:' in frontmatter`);
  const repo = expandHome(data.repo);

  const lines = raw.split("\n");
  const tasks = [];
  let currentHeader = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) currentHeader = h[1];
    const m = line.match(LIVE_BG_RE);
    if (m) {
      tasks.push({
        lineIndex: i,
        rawLine: line,
        indent: m[1],
        mode: m[2],
        opts: m[3] || "",
        task: m[4],
        section: currentHeader,
      });
    }
  }

  return { raw, lines, data, content, repo, tasks };
}

async function updateLine(filePath, lineIndex, oldLine, newLine) {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");
  if (lines[lineIndex] !== oldLine) {
    // File drifted — try to find the old line elsewhere.
    const alt = lines.indexOf(oldLine);
    if (alt === -1) {
      console.error(`dispatch: could not locate line to update in ${filePath}`);
      return;
    }
    lineIndex = alt;
  }
  lines[lineIndex] = newLine;
  await writeFile(filePath, lines.join("\n"));
}

async function insertAfter(filePath, anchorLine, newLines) {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const idx = lines.indexOf(anchorLine);
  if (idx === -1) {
    console.error(`dispatch: anchor line not found, appending at EOF`);
    lines.push(...newLines);
  } else {
    lines.splice(idx + 1, 0, ...newLines);
  }
  await writeFile(filePath, lines.join("\n"));
}

function buildPrompt({ noteName, repo, task, section }) {
  return [
    `You are running as a background agent triggered from the Obsidian note "${noteName}".`,
    `Working directory: ${repo}`,
    section ? `Section in note: ${section}` : null,
    ``,
    `Task:`,
    task,
    ``,
    `When you finish, write a short report (what you did, any decisions, follow-ups) to REPORT_PATH. REPORT_PATH will be provided as an environment variable.`,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

function buildLivePrompt({ noteName, repo, task, section }) {
  return [
    `Triggered from Obsidian note "${noteName}" (section: ${section || "—"}).`,
    `Working directory: ${repo}`,
    ``,
    `Task:`,
    task,
  ].join("\n");
}

async function runLive(filePath, t) {
  const { repo, task, section } = t;
  const noteName = path.basename(filePath, ".md");
  const prompt = buildLivePrompt({ noteName, repo, task, section });

  const ts = Date.now();
  const promptFile = path.join(tmpdir(), `agent-prompt-${ts}.md`);
  await writeFile(promptFile, prompt);

  const tabTitle = slug(task);
  // AppleScript: open new iTerm window, cd repo, set tab title, run claude.
  const escaped = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cmd = `cd "${escaped(repo)}" && printf '\\033]0;${escaped(tabTitle)}\\007' && claude "$(cat ${promptFile})"`;
  const osa = `
tell application "iTerm"
  activate
  create window with default profile
  tell current session of current window
    write text "${escaped(cmd)}"
  end tell
end tell
`;

  await new Promise((resolve, reject) => {
    const p = spawn("osascript", ["-e", osa], { stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))
    );
  });

  console.log(`dispatch: live task opened in iTerm — "${tabTitle}"`);
}

async function runBg(filePath, t) {
  const { repo, task, section, rawLine, indent } = t;
  const noteName = path.basename(filePath, ".md");

  // Mark line as in-progress: [ ] -> [~]
  const runningLine = rawLine.replace("- [ ] @agent:bg", "- [~] @agent:bg");
  await updateLine(filePath, t.lineIndex, rawLine, runningLine);

  // Prepare report path inside the repo.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(repo, "_tmp", "agent-reports");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${ts}-${slug(task, 40).replace(/\s+/g, "_")}.md`);

  const prompt = buildPrompt({ noteName, repo, task, section });

  console.log(`dispatch: [bg] starting "${slug(task, 60)}" in ${repo}`);

  const result = await new Promise((resolve) => {
    const p = spawn(
      "claude",
      ["-p", prompt, "--allowedTools", "Read,Write,Edit,Bash"],
      { cwd: repo, env: { ...process.env, REPORT_PATH: reportPath }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("exit", (code) => resolve({ code, out, err }));
  });

  if (result.code !== 0) {
    console.error(`dispatch: [bg] failed (${result.code}): ${slug(task, 60)}`);
    if (result.err) console.error(result.err);
    // Revert to [ ] so user can retry.
    await updateLine(filePath, t.lineIndex, runningLine, rawLine);
    return;
  }

  // Write a report if the agent didn't.
  try {
    await readFile(reportPath);
  } catch {
    await writeFile(reportPath, `# ${task}\n\n(no explicit report written — stdout below)\n\n${result.out}\n`);
  }

  const doneLine = runningLine.replace("- [~] @agent:bg", "- [x] @agent:bg");
  const relReport = path.relative(path.dirname(filePath), reportPath);
  const reportBullet = `${indent}  - report: [[${relReport}]]`;
  await updateLine(filePath, t.lineIndex, runningLine, doneLine);
  await insertAfter(filePath, doneLine, [reportBullet]);

  console.log(`dispatch: [bg] done — "${slug(task, 60)}"`);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) die("usage: dispatch.js <note.md>");
  const abs = path.resolve(filePath);

  let parsed;
  try {
    parsed = await parseNote(abs);
  } catch (e) {
    die(`could not parse note: ${e.message}`);
  }

  try {
    await readFile(path.join(parsed.repo, ".git/HEAD")).catch(async () => {
      // Not necessarily a git repo — just verify the directory exists.
      const { stat } = await import("node:fs/promises");
      await stat(parsed.repo);
    });
  } catch {
    die(`repo does not exist: ${parsed.repo}`);
  }

  if (parsed.tasks.length === 0) {
    console.log("dispatch: no unchecked @agent tasks found");
    return;
  }

  const queue = new PQueue({ concurrency: 2 });
  const jobs = parsed.tasks.map((t) =>
    queue.add(async () => {
      try {
        if (t.mode === "live") await runLive(abs, t);
        else await runBg(abs, t);
      } catch (e) {
        console.error(`dispatch: task failed — ${e.message}`);
      }
    })
  );

  await Promise.all(jobs);
  console.log("dispatch: all tasks dispatched");
}

main().catch((e) => die(e.stack || e.message));
