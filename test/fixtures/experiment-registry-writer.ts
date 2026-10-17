import {
  ExperimentRegistry,
  type ExperimentInput,
} from "../../src/experiment-registry.js";

const [path, catalog, encoded] = process.argv.slice(2);
if (!path || !catalog || !encoded)
  throw new Error("Expected registry path, catalog path, and base64 input");
const input = JSON.parse(
  Buffer.from(encoded, "base64url").toString("utf8"),
) as ExperimentInput;
await new ExperimentRegistry(path, catalog).add(input);
