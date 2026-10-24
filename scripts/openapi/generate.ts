import { writeFile } from "node:fs/promises";
import { generateSpecs } from "hono-openapi";
import { apiRouter } from "../../src/api/router";
import { AUTH_BASE_PATH } from "../../src/auth/constants";
import { createSchemaAuth } from "../../src/auth/schema-auth";

const appSpec = await generateSpecs(apiRouter, {
  documentation: {
    info: {
      title: "Hono Scaffolded App API",
      version: "1.0.0",
      description: "HTTP API for the Hono scaffolded application.",
    },
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
        },
      },
    },
  },
});

const auth = createSchemaAuth();
const authSpec = await auth.api.generateOpenAPISchema();

const authPaths = Object.fromEntries(
  Object.entries(authSpec.paths ?? {}).map(([path, pathItem]) => [
    path.startsWith(AUTH_BASE_PATH) ? path : `${AUTH_BASE_PATH}${path}`,
    Object.fromEntries(
      Object.entries(pathItem ?? {}).map(([method, operation]) => [
        method,
        operation && typeof operation === "object" && "tags" in operation
          ? { ...operation, tags: ["Auth"] }
          : operation,
      ]),
    ),
  ]),
);

const tags = [...(appSpec.tags ?? [])];
for (const tag of (authSpec.tags ?? []).filter((tag) => tag.name !== "Default")) {
  if (!tags.some((existing) => existing.name === tag.name)) tags.push(tag);
}
if (!tags.some((tag) => tag.name === "Auth")) {
  tags.push({ name: "Auth", description: "Authentication endpoints." });
}

const spec = {
  ...appSpec,
  paths: {
    ...authPaths,
    ...appSpec.paths,
  },
  components: {
    ...authSpec.components,
    ...appSpec.components,
    schemas: {
      ...authSpec.components?.schemas,
      ...appSpec.components?.schemas,
    },
    securitySchemes: {
      ...authSpec.components?.securitySchemes,
      ...appSpec.components?.securitySchemes,
    },
  },
  ...(tags.length > 0 ? { tags } : {}),
};

await writeFile("openapi.json", `${JSON.stringify(spec, null, 2)}\n`);
