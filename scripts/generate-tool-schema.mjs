import { writeFile } from "node:fs/promises";
import { jsonSchemaCatalog } from "../dist/src/tool-contract.js";

await writeFile(new URL("../config/mcp-tools.schema.json", import.meta.url), `${JSON.stringify(jsonSchemaCatalog(), null, 2)}\n`);
