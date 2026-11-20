// API documentation routes, mounted only when DOCS_ENABLED=true:
//   /openapi.json  the OpenAPI document, derived from the HttpApi definition
//   /docs          Scalar API reference
//   /llms.txt      the same document as Markdown, for LLM tools
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiScalar, OpenApi } from "effect/http-api";
import { HttpConfig } from "../config";
import { Api } from "./api";

export const openApiDocument = () => OpenApi.fromApi(Api);

const llmsRoute = Effect.gen(function* () {
  const markdown = yield* Effect.cached(
    Effect.promise(async () => {
      const { createMarkdownFromOpenApi } = await import("@scalar/openapi-to-markdown");
      return createMarkdownFromOpenApi(JSON.stringify(openApiDocument()));
    }),
  );
  return HttpRouter.add(
    "GET",
    "/llms.txt",
    Effect.map(markdown, (text) =>
      HttpServerResponse.text(text, {
        contentType: "text/markdown; charset=utf-8",
        headers: { "cache-control": "public, max-age=300" },
      }),
    ),
  );
});

export const DocsLive = Layer.unwrap(
  Effect.gen(function* () {
    const { docsEnabled } = yield* HttpConfig;
    if (!docsEnabled) return Layer.empty;

    return Layer.mergeAll(
      HttpRouter.add("GET", "/openapi.json", HttpServerResponse.jsonUnsafe(openApiDocument())),
      HttpApiScalar.layer(Api, { path: "/docs" }),
      yield* llmsRoute,
    );
  }),
);
