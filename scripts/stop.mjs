#!/usr/bin/env node
/**
 * GammaCode stop — kills lingering GammaCode processes holding ports
 * 3030 (API), 3031 (terminal WS) and 3000 (web dev). Run with: pnpm stop
 */
import { execSync } from "node:child_process";

const PORTS = [3000, 3030, 3031];
let killed = 0;

for (const port of PORTS) {
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `netstat -ano -p TCP | findstr LISTENING | findstr :${port}`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const pids = new Set(
        out.split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && /^\d+$/.test(pid))
      );
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          console.log(`Killed PID ${pid} (port ${port})`);
          killed++;
        } catch {
          console.log(`Could not kill PID ${pid} (port ${port}) — try running as administrator`);
        }
      }
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: "ignore" });
      console.log(`Cleared port ${port}`);
      killed++;
    }
  } catch {
    // findstr/lsof exit non-zero when nothing matched — port is free
  }
}

console.log(killed > 0 ? `\nDone — ${killed} process(es) stopped. Ports are free; start again with: pnpm dev` : "\nNo GammaCode processes found on ports 3000/3030/3031 — nothing to stop.");
