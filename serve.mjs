#!/usr/bin/env node
/** Windows-friendly entry — `node serve.mjs` starts the desk. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const viteJs = path.join(root, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [viteJs, "dev", "--host", "0.0.0.0", "--port", "8080"], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
