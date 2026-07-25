#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [inputDirectory, output = "docs/compatibility-ci.md"] = process.argv.slice(2);
if (!inputDirectory) throw new Error("usage: generate-compatibility-report <result-directory> [output]");
const files = readdirSync(inputDirectory, { recursive: true })
  .filter((name) => basename(String(name)) === "result.json")
  .map((name) => join(inputDirectory, String(name)));
const results = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
const expected = new Set(["ubuntu-24.04:22", "ubuntu-24.04:24", "macos-14:22", "macos-14:24"]);
const commits = new Set(results.map(({ commit }) => commit));
const actual = results.map(({ runner, requestedNode }) => `${runner}:${requestedNode}`);
if (results.length !== expected.size || new Set(actual).size !== expected.size || actual.some((lane) => !expected.has(lane))) {
  throw new Error(`expected exactly ${[...expected].join(", ")}; received ${actual.join(", ")}`);
}
if (commits.size !== 1 || results.some(({ conclusion }) => conclusion !== "success")) {
  throw new Error("compatibility documentation requires one exact commit and four successful lanes");
}
results.sort((left, right) => left.runner.localeCompare(right.runner) || left.requestedNode - right.requestedNode);
const lines = [
  "# Generated compatibility results",
  "",
  `Exact commit: \`${results[0].commit}\``,
  "",
  "This report is generated from uploaded GitHub Actions lane results. Do not edit it by hand.",
  "",
  "| Runner | Platform | Architecture | Node | npm | Verification |",
  "| --- | --- | --- | --- | --- | --- |",
  ...results.map(({ runner, detected, conclusion }) =>
    `| ${runner} | ${detected.platform} ${detected.release} | ${detected.architecture} | ${detected.node} | ${detected.npm} | ${conclusion} |`),
  "",
  "The Superset Desktop discovery smoke test is skipped in generic CI because those runners do not include a configured Desktop host. Its injected-runner contract remains covered in every lane.",
  "",
  "Windows is unsupported and is not represented by this report.",
  "",
];
writeFileSync(resolve(output), `${lines.join("\n")}\n`);
