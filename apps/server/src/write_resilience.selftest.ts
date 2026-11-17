import assert from "node:assert/strict";
import { resolveWorkspacePath, extractFilePath, extractFileContent } from "./paths.js";
import { DEFAULT_TOOL_PERMISSIONS } from "./permissions.js";
import { DEFAULT_CONFIG } from "./config.js";

const fakeRoot = "/test/workspace";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// 1. Path Resolution Resilience
test("resolveWorkspacePath handles normal relative path", () => {
  const res = resolveWorkspacePath(fakeRoot, "src/App.tsx");
  assert.ok(res);
  assert.equal(res.relPath, "src/App.tsx");
  assert.equal(res.absPath, "/test/workspace/src/App.tsx");
});

test("resolveWorkspacePath normalizes leading slashes", () => {
  const res = resolveWorkspacePath(fakeRoot, "/src/App.tsx");
  assert.ok(res);
  assert.equal(res.relPath, "src/App.tsx");
  assert.equal(res.absPath, "/test/workspace/src/App.tsx");
});

test("resolveWorkspacePath normalizes synthetic /workspace/ prefix", () => {
  const res = resolveWorkspacePath(fakeRoot, "/workspace/package.json");
  assert.ok(res);
  assert.equal(res.relPath, "package.json");
  assert.equal(res.absPath, "/test/workspace/package.json");
});

test("resolveWorkspacePath normalizes synthetic workspace/ prefix without slash", () => {
  const res = resolveWorkspacePath(fakeRoot, "workspace/src/index.ts");
  assert.ok(res);
  assert.equal(res.relPath, "src/index.ts");
});

test("resolveWorkspacePath normalizes synthetic /project/ prefix", () => {
  const res = resolveWorkspacePath(fakeRoot, "/project/src/index.ts");
  assert.ok(res);
  assert.equal(res.relPath, "src/index.ts");
});

test("resolveWorkspacePath normalizes synthetic /app/ prefix", () => {
  const res = resolveWorkspacePath(fakeRoot, "/app/src/index.ts");
  assert.ok(res);
  assert.equal(res.relPath, "src/index.ts");
});

test("resolveWorkspacePath strips surrounding quotes and whitespace", () => {
  const res1 = resolveWorkspacePath(fakeRoot, '  "src/index.ts" ');
  assert.ok(res1);
  assert.equal(res1.relPath, "src/index.ts");

  const res2 = resolveWorkspacePath(fakeRoot, " 'src/index.ts' ");
  assert.ok(res2);
  assert.equal(res2.relPath, "src/index.ts");
});

test("resolveWorkspacePath normalizes Windows backslashes", () => {
  const res = resolveWorkspacePath(fakeRoot, "src\\components\\Button.tsx");
  assert.ok(res);
  assert.equal(res.relPath.replace(/\\/g, "/"), "src/components/Button.tsx");
});

test("resolveWorkspacePath blocks directory traversal attempts", () => {
  const res = resolveWorkspacePath(fakeRoot, "../../etc/passwd");
  assert.equal(res, null);
});

// 2. Argument Extraction Resilience
test("extractFilePath extracts from all common LLM argument aliases", () => {
  assert.equal(extractFilePath({ path: "foo.txt" }), "foo.txt");
  assert.equal(extractFilePath({ filePath: "foo.txt" }), "foo.txt");
  assert.equal(extractFilePath({ file_path: "foo.txt" }), "foo.txt");
  assert.equal(extractFilePath({ filename: "foo.txt" }), "foo.txt");
  assert.equal(extractFilePath({ fileName: "foo.txt" }), "foo.txt");
  assert.equal(extractFilePath({ file: "foo.txt" }), "foo.txt");
  assert.equal(extractFilePath({}), "");
});

test("extractFileContent extracts from all common LLM content aliases", () => {
  assert.equal(extractFileContent({ content: "hello" }), "hello");
  assert.equal(extractFileContent({ code: "hello" }), "hello");
  assert.equal(extractFileContent({ text: "hello" }), "hello");
  assert.equal(extractFileContent({ file_content: "hello" }), "hello");
  assert.equal(extractFileContent({}), "");
});

// 3. Permission Defaults
test("DEFAULT_TOOL_PERMISSIONS allows write_file and edit_file by default", () => {
  assert.equal(DEFAULT_TOOL_PERMISSIONS.write_file, "allow");
  assert.equal(DEFAULT_TOOL_PERMISSIONS.edit_file, "allow");
  assert.equal(DEFAULT_TOOL_PERMISSIONS.read_file, "allow");
  assert.equal(DEFAULT_TOOL_PERMISSIONS.list_files, "allow");
  assert.equal(DEFAULT_TOOL_PERMISSIONS.grep_search, "allow");
});

test("DEFAULT_CONFIG permissions allow write_file and edit_file by default", () => {
  assert.equal(DEFAULT_CONFIG.permissions?.tools?.write_file, "allow");
  assert.equal(DEFAULT_CONFIG.permissions?.tools?.edit_file, "allow");
  assert.equal(DEFAULT_CONFIG.permissions?.tools?.read_file, "allow");
  assert.equal(DEFAULT_CONFIG.permissions?.tools?.list_files, "allow");
});

console.log("\nAll write resilience selftests passed.");
