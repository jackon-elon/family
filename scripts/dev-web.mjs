import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 600).unref();
}
function launch(args, label) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${label} 启动失败：${error.message}`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${label} 已停止`);
      stop(code || 0);
    }
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
launch(["server/index.cjs"], "后端");
launch(
  ["node_modules/vite/bin/vite.js", "--config", "frontend/vite.config.ts"],
  "前端",
);
