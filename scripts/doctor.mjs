#!/usr/bin/env node
/**
 * GammaCode doctor — diagnoses why the server/app may fail to launch.
 * Run with: pnpm doctor
 * Exit code 0 = all critical checks pass, 1 = something will block launch.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let warnings = 0;

const pass = (msg) => console.log(`  PASS  ${msg}`);
const warn = (msg) => { warnings++; console.log(`  WARN  ${msg}`); };
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 800);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

console.log("\nGammaCode doctor\n" + "=".repeat(50));

// 1. Node version
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) pass(`Node ${process.versions.node} (>= 20 required)`);
else fail(`Node ${process.versions.node} is too old — install Node 20+ (https://nodejs.org)`);

// 2. pnpm
try {
  const pnpmVersion = execSync("pnpm --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  pass(`pnpm ${pnpmVersion}`);
} catch {
  fail("pnpm not found — run: corepack enable && corepack prepare pnpm@10.4.1 --activate");
}

// 3. Dependencies installed
if (existsSync(path.join(root, "node_modules"))) pass("Dependencies installed (node_modules exists)");
else fail("Dependencies missing — run: pnpm install");

// 4. Shared package built (server/web import it from dist)
if (existsSync(path.join(root, "packages/shared/dist/index.js"))) {
  pass("Shared package built (packages/shared/dist)");
} else {
  fail("Shared package not built — run: pnpm --filter @gamma-code/shared build");
}

// 5. Server dist (needed for packaged/production desktop launch)
if (existsSync(path.join(root, "apps/server/dist/index.js"))) {
  pass("Server build found (apps/server/dist/index.js)");
} else {
  warn("Server dist not built (only needed for packaged/production start) — build with: pnpm --filter @gamma-code/server build");
}

// 6. node-pty native module loadable
try {
  execSync('node -e "import(\'node-pty\').then(()=>process.exit(0)).catch(()=>process.exit(1))"', {
    cwd: path.join(root, "apps/server"),
    stdio: "ignore",
    timeout: 20000
  });
  pass("node-pty native module loads (integrated terminal will work)");
} catch {
  fail("node-pty failed to load — run: pnpm rebuild node-pty   (may need build tools: Visual Studio C++ on Windows)");
}

// 7. Ports
for (const [port, label] of [[3030, "API server"], [3031, "terminal WS"], [3000, "web dev server"]]) {
  if (await checkPort(port)) {
    warn(`Port ${port} (${label}) is already in use — if that's not your own running instance, run: pnpm stop`);
  } else {
    pass(`Port ${port} (${label}) is free`);
  }
}

// 8. Environment / API keys
const envPath = path.join(root, "apps/server/.env");
if (existsSync(envPath)) pass("apps/server/.env exists");
else warn("apps/server/.env missing — copy apps/server/.env.example to apps/server/.env and add at least one provider API key (or add keys in the app Settings)");

console.log("=".repeat(50));
if (failures === 0) {
  console.log(`All critical checks passed${warnings ? ` (${warnings} warning(s))` : ""}. Start with: pnpm dev\n`);
  process.exit(0);
} else {
  console.log(`${failures} failure(s), ${warnings} warning(s) — fix the FAIL items above, then re-run: pnpm doctor\n`);
  process.exit(1);
}
