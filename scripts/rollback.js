#!/usr/bin/env node
// rollback.js — interactively reset the vault to an earlier commit.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import simpleGit from "simple-git";

function die(msg) {
  console.error(`rollback: ${msg}`);
  process.exit(1);
}

async function main() {
  const vaultArg = process.argv[2] || process.env.VAULT_PATH;
  if (!vaultArg) die("usage: rollback.js <vault-path>");
  const vault = path.resolve(vaultArg);

  const git = simpleGit(vault);
  if (!(await git.checkIsRepo())) die(`not a git repo: ${vault}`);

  const log = await git.log({ maxCount: 20 });
  if (log.all.length === 0) die("no commits in vault");

  console.log(`\nRecent commits in ${vault}:\n`);
  log.all.forEach((c, i) => {
    const short = c.hash.slice(0, 7);
    console.log(`  ${String(i).padStart(2)}  ${short}  ${c.message}`);
  });
  console.log();

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("Reset --hard to which number? (blank to cancel) ");
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) {
    console.log("cancelled.");
    return;
  }

  const idx = Number(trimmed);
  if (!Number.isInteger(idx) || idx < 0 || idx >= log.all.length) {
    die(`invalid selection: ${trimmed}`);
  }

  const target = log.all[idx];
  const status = await git.status();
  if (!status.isClean()) {
    console.warn(`\nwarning: vault has uncommitted changes — they will be lost.`);
  }

  const rl2 = readline.createInterface({ input, output });
  const confirm = await rl2.question(`Hard-reset to ${target.hash.slice(0, 7)} "${target.message}"? [y/N] `);
  rl2.close();

  if (confirm.trim().toLowerCase() !== "y") {
    console.log("cancelled.");
    return;
  }

  await git.reset(["--hard", target.hash]);
  console.log(`done. vault is now at ${target.hash.slice(0, 7)}.`);
}

main().catch((e) => die(e.stack || e.message));
