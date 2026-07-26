import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = Object.fromEntries(
  (await readFile(resolve(root, "provenance/CHECKPOINT.lock"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split("=", 2)),
);
const checksums = (await readFile(resolve(root, "provenance/checksums.txt"), "utf8"))
  .trim()
  .split("\n");
const variantsText = await readFile(resolve(root, "provenance/variants.json"), "utf8");
const variants = JSON.parse(variantsText);
const recordedManifestHash = (
  await readFile(resolve(root, "provenance/variants.json.sha256"), "utf8")
).split(" ", 1)[0];

if (!/^[0-9a-f]{40}$/.test(lock.revision)) throw new Error("invalid pinned revision");
if (lock.license !== "apache-2.0") throw new Error("unexpected license");
if (checksums.length !== 8 || checksums.some((line) => !/^[0-9a-f]{64} {2}\S+$/.test(line))) {
  throw new Error("checksums must contain eight SHA-256 entries");
}
const families = variants.variants.map(({ family }) => family).sort();
if (families.join(",") !== "BF16,GGUF,MLX,SFT") throw new Error("variant families incomplete");
if (createHash("sha256").update(variantsText).digest("hex") !== recordedManifestHash) {
  throw new Error("variant manifest digest mismatch");
}
for (const variant of variants.variants) {
  if (!/^[0-9a-f]{40}$/.test(variant.revision) || variant.license !== "apache-2.0") {
    throw new Error(`invalid ${variant.family} manifest`);
  }
  for (const artifact of variant.artifacts) {
    if (!Number.isSafeInteger(artifact.bytes) || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error(`invalid ${variant.family} artifact`);
    }
  }
}
console.log("Provenance manifests verified: BF16, SFT, GGUF, MLX");
