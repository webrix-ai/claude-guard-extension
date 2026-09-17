#!/usr/bin/env node
// Zero-dependency lint: syntax-check every shipped JavaScript file and validate
// that the manifest and managed schema are well-formed JSON.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const IGNORE = new Set(["node_modules", "dist", ".git", "test"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

let failed = 0;

for (const file of walk(root, [])) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`ok   ${path.relative(root, file)}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}\n${err.stderr}`);
  }
}

for (const json of ["manifest.json", "managed_schema.json", "package.json"]) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, json), "utf8"));
    console.log(`ok   ${json}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${json}: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed.`);
  process.exit(1);
}
console.log("\nAll files passed syntax check.");
