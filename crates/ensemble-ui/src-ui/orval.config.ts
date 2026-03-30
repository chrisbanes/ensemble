import { defineConfig } from "orval";

export default defineConfig({
  ensemble: {
    input: {
      target: "./openapi.json",
    },
    output: {
      mode: "tags-split",
      target: "./src/generated/api",
      schemas: "./src/generated/models",
      client: "react-query",
      override: {
        mutator: {
          path: "./src/fetch-client.ts",
          name: "customFetch",
        },
        query: {
          useQuery: true,
          useMutation: true,
          version: 5,
        },
      },
    },
  },
});
