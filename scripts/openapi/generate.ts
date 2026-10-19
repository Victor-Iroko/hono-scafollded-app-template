import { writeFile } from "node:fs/promises";
import { generateSpecs } from "hono-openapi";
import { apiRouter } from "../../src/api/router";

const spec = await generateSpecs(apiRouter, {
  documentation: {
    info: {
      title: "Hono Scaffolded App API",
      version: "1.0.0",
      description: "HTTP API for the Hono scaffolded application.",
    },
  },
});

await writeFile("openapi.json", `${JSON.stringify(spec, null, 2)}\n`);
