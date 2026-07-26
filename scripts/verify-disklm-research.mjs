import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const fail = (message) => {
  throw new Error(`DiskLM research verification failed: ${message}`);
};

const [csv, bib, contractMarkdown, contractJson, priorArt, licensing] =
  await Promise.all([
    read("docs/gap-table.csv"),
    read("docs/prior-art.bib"),
    read("EVAL_CONTRACT.md"),
    read("config/disklm-eval-contract.json"),
    read("docs/prior-art.md"),
    read("docs/licensing.md"),
  ]);

const lines = csv.trim().split("\n");
const expectedHeader =
  "key,year,category,dram_assumption,movement_granularity,page_locality_claim";
if (lines.shift() !== expectedHeader) fail("gap table header changed");
if (lines.length < 25)
  fail(`expected at least 25 works, found ${lines.length}`);

const keys = [];
for (const [index, line] of lines.entries()) {
  const match = line.match(
    /^([^,]+),(\d{4}),([^,]+),"([^"]+)",([^,]+),"([^"]+)"$/,
  );
  if (!match) fail(`malformed CSV row ${index + 2}`);
  const [, key, , , dram, granularity, claim] = match;
  if (claim.length < 45 || !claim.endsWith("."))
    fail(`${key} needs a falsifiable one-line claim`);
  if (!dram || !granularity) fail(`${key} lacks normalized assumptions`);
  keys.push(key);
}
if (new Set(keys).size !== keys.length) fail("gap table keys are not unique");

const urls = [...bib.matchAll(/url=\{(https:\/\/[^}]+)\}/g)].map(
  (match) => match[1],
);
if (urls.length !== keys.length)
  fail("every bibliography entry needs one HTTPS URL");
if (new Set(urls).size !== urls.length)
  fail("bibliography URLs are not unique");
const bibKeys = [...bib.matchAll(/^@\w+\{([^,]+),/gm)].map((match) => match[1]);
if (JSON.stringify(bibKeys.sort()) !== JSON.stringify([...keys].sort()))
  fail("gap table and bibliography keys differ");
for (const key of keys) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = new RegExp(
    `^@\\w+\\{${escaped},([\\s\\S]*?)(?=^@|$)`,
    "m",
  ).exec(bib)?.[1];
  if (
    !entry ||
    !/title=\{[^}]+\}/.test(entry) ||
    !/year=\{\d{4}\}/.test(entry) ||
    !/url=\{https:\/\//.test(entry)
  )
    fail(`${key} bibliography entry is incomplete`);
}

const contract = JSON.parse(contractJson);
if (contract.schemaVersion !== 1 || contract.contractId !== "disklm-eval-v1")
  fail("unexpected contract identity");
if (contract.storage.logicalPageBytes !== 4096)
  fail("logical page size must remain 4096 bytes in v1");
if (JSON.stringify(contract.seeds) !== JSON.stringify([17, 29, 41]))
  fail("seed policy changed without a contract version change");
if (
  contract.baselines.length < 5 ||
  contract.primaryMetrics.length < 5 ||
  contract.qualitySuites.length !== 4 ||
  contract.hardwareClasses.length !== 2 ||
  contract.qualitySuites.some(
    (suite) => !suite.id || !suite.metric || suite.fewshot !== 0,
  ) ||
  contract.hardwareClasses.some(
    (hardware) => !hardware.id || hardware.required.length < 5,
  )
)
  fail("contract lost a baseline or primary metric");

for (const phrase of [
  "useful_parameter_byte_ratio",
  "unique_pages_per_decode_token",
  "amendment",
]) {
  if (!contractMarkdown.toLowerCase().includes(phrase.toLowerCase()))
    fail(`contract is missing ${phrase}`);
}
if (!priorArt.includes("no primary LLM-inference publication"))
  fail("UPT documented-negative answer is missing");
if (!priorArt.includes("No reviewed work jointly specifies"))
  fail("bounded gap statement is missing");
if (!priorArt.includes("Search boundary (2026-07-26)"))
  fail("UPT negative lacks a reproducible search boundary");
if (!licensing.includes("PER-361") || !licensing.includes("fails closed"))
  fail("licensing memo does not defer to pinned provenance safely");

const benchmarkFiles = [];
for (const path of process.argv.slice(2)) benchmarkFiles.push(await read(path));
for (const source of benchmarkFiles) {
  if (!source.includes("disklm-contract.mjs"))
    fail("benchmark does not import the frozen contract");
  for (const forbidden of ["disklm-eval-v1", "4096", "[17, 29, 41]"])
    if (source.includes(forbidden)) fail(`benchmark redefines ${forbidden}`);
}

console.log(
  `Verified DiskLM research contract and ${keys.length} cited works.`,
);
