const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VAULT = path.join(ROOT, "vault");
const SCRIPT = path.join(ROOT, "scripts", "gardener.js");

const WIDTH = 360;
const MIN_H = 72;
const MAX_H = 560;
const LINES_PER_RUN = 60;

const runs = new Map();
let nextId = 1;
let win = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIDTH,
    height: MIN_H,
    x: workArea.x + Math.round(workArea.width / 2 - WIDTH / 2),
    y: workArea.y + 12,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on("launch-gardener", () => {
  const id = nextId++;
  const child = spawn("node", [SCRIPT, VAULT], {
    cwd: ROOT,
    env: { ...process.env },
  });
  const run = {
    id,
    pid: child.pid,
    startedAt: Date.now(),
    status: "running",
    lines: ["démarrage…"],
  };
  runs.set(id, run);

  const onChunk = (data) => {
    const chunk = data.toString();
    for (const line of chunk.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed.trim()) continue;
      run.lines.push(trimmed.slice(0, 400));
    }
    if (run.lines.length > LINES_PER_RUN) {
      run.lines.splice(0, run.lines.length - LINES_PER_RUN);
    }
    broadcast();
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("exit", (code) => {
    run.status = code === 0 ? "done" : "error";
    run.endedAt = Date.now();
    broadcast();
  });
  broadcast();
});

ipcMain.on("clear-finished", () => {
  for (const [id, r] of runs) if (r.status !== "running") runs.delete(id);
  broadcast();
});

ipcMain.on("set-height", (_, height) => {
  if (!win) return;
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(height)));
  const b = win.getBounds();
  if (b.height !== h) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h }, true);
  }
});

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git", ["-C", VAULT, ...args], { maxBuffer: 2_000_000 },
      (err, out) => (err ? reject(err) : resolve(out))
    );
  });
}

ipcMain.handle("get-diff", async () => {
  try {
    const [tracked, untrackedList] = await Promise.all([
      runGit(["diff", "--no-color", "HEAD"]),
      runGit(["ls-files", "--others", "--exclude-standard"]),
    ]);
    const files = untrackedList.trim().split("\n").filter(Boolean);
    let extra = "";
    for (const f of files) {
      try {
        const content = await fs.promises.readFile(path.join(VAULT, f), "utf8");
        const lines = content.split("\n");
        extra += `diff --git a/${f} b/${f}\n`;
        extra += `new file mode 100644\n`;
        extra += `--- /dev/null\n+++ b/${f}\n`;
        extra += `@@ -0,0 +1,${lines.length} @@\n`;
        extra += lines.map((l) => `+${l}`).join("\n") + "\n";
      } catch {}
    }
    return (tracked || "") + (extra ? (tracked ? "\n" : "") + extra : "");
  } catch (e) {
    return `(git diff failed: ${e.message})`;
  }
});

function broadcast() {
  if (!win) return;
  const list = Array.from(runs.values())
    .map((r) => ({
      id: r.id,
      pid: r.pid,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status,
      lines: r.lines,
      last: r.lines[r.lines.length - 1] || "",
    }))
    .sort((a, b) => b.id - a.id);
  win.webContents.send("runs", list);
}
