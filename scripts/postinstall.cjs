// Cross-platform replacement for the old shell one-liner:
//   chmod +x node_modules/.pnpm/node-pty@*/.../spawn-helper 2>/dev/null || true
// That string fails under cmd.exe on Windows and made `pnpm install` exit 1.
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "darwin") {
  process.exit(0);
}

const pnpmDir = path.join(__dirname, "..", "node_modules", ".pnpm");

let entries = [];
try {
  entries = fs.readdirSync(pnpmDir);
} catch {
  process.exit(0);
}

for (const entry of entries) {
  if (!entry.startsWith("node-pty@")) continue;
  const helper = path.join(
    pnpmDir,
    entry,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper"
  );
  try {
    fs.chmodSync(helper, 0o755);
  } catch {
    // prebuild not present — node-pty falls back to a rebuild
  }
}
