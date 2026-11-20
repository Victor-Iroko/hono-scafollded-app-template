// API documentation routes, mounted only when DOCS_ENABLED=true:
//   /openapi.json  the HttpApi document merged with Better Auth's endpoints
//   /docs          Scalar API reference for that document
//   /llms.txt      the same document as Markdown, for LLM tools
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import { AUTH_BASE_PATH, BetterAuth, type AppAuth } from "../auth/auth";
import { HttpConfig } from "../config";
import { Api } from "./api";

// Loaded in the browser on /docs only; the CSP is relaxed for that path.
const SCALAR_SCRIPT =
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.77.0/dist/browser/standalone.min.js";

type OpenApiDocument = Record<string, any>;

/** Adds Better Auth's endpoints, under one "Auth" tag, to the HttpApi document. */
function mergeAuthDocument(app: OpenApiDocument, auth: OpenApiDocument): OpenApiDocument {
  const authPaths = Object.fromEntries(
    Object.entries(auth.paths ?? {}).map(([path, item]) => [
      path.startsWith(AUTH_BASE_PATH) ? path : `${AUTH_BASE_PATH}${path}`,
      Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([method, operation]) => [
          method,
          operation && typeof operation === "object" ? { ...operation, tags: ["Auth"] } : operation,
        ]),
      ),
    ]),
  );

  return {
    ...app,
    paths: { ...authPaths, ...app.paths },
    components: {
      ...app.components,
      schemas: { ...auth.components?.schemas, ...app.components?.schemas },
      securitySchemes: { ...auth.components?.securitySchemes, ...app.components?.securitySchemes },
    },
    tags: [
      ...(app.tags ?? []),
      { name: "Auth", description: "Sign-up, sign-in, sessions and accounts." },
    ],
  };
}

export const buildOpenApiDocument = (auth: AppAuth) =>
  Effect.promise(() => auth.api.generateOpenAPISchema()).pipe(
    Effect.map((authDocument) => mergeAuthDocument(OpenApi.fromApi(Api), authDocument)),
  );

const docsPage = (title: string) =>
  HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <div id="api-reference"></div>
    <script src="${SCALAR_SCRIPT}" crossorigin></script>
    <script>Scalar.createApiReference("#api-reference", { url: "/openapi.json" })</script>
  </body>
</html>`);

export const DocsLive = Layer.unwrap(
  Effect.gen(function* () {
    const { docsEnabled } = yield* HttpConfig;
    if (!docsEnabled) return Layer.empty;

    const auth = yield* BetterAuth;
    const document = yield* Effect.cached(buildOpenApiDocument(auth));
    const markdown = yield* Effect.cached(
      Effect.flatMap(document, (spec) =>
        Effect.promise(async () => {
          const { createMarkdownFromOpenApi } = await import("@scalar/openapi-to-markdown");
          return createMarkdownFromOpenApi(JSON.stringify(spec));
        }),
      ),
    );

    return Layer.mergeAll(
      HttpRouter.add("GET", "/openapi.json", Effect.map(document, HttpServerResponse.jsonUnsafe)),
      HttpRouter.add("GET", "/docs", docsPage(OpenApi.fromApi(Api).info.title)),
      HttpRouter.add(
        "GET",
        "/llms.txt",
        Effect.map(markdown, (text) =>
          HttpServerResponse.text(text, {
            contentType: "text/markdown; charset=utf-8",
            headers: { "cache-control": "public, max-age=300" },
          }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(BetterAuth.layer));
