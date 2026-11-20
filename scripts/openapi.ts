// Writes openapi.json from the HttpApi definition (used by Fern). The running
// server serves the same document at /openapi.json when DOCS_ENABLED=true.
import { writeFile } from "node:fs/promises";
import { openApiDocument } from "../src/http/docs";

await writeFile("openapi.json", `${JSON.stringify(openApiDocument(), null, 2)}\n`);
