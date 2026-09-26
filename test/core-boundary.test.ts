import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

function resolveRelativeImport(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier);
  const extension = extname(target);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension))
    return `${target.slice(0, -extension.length)}${extension === ".jsx" ? ".tsx" : ".ts"}`;
  return target;
}

function scanCoreGraph(coreRoot: string): string[] {
  const files = sourceFiles(coreRoot);
  if (!files.length) return ["Core source directory is missing or empty"];

  const root = resolve(coreRoot);
  const violations: string[] = [];
  const recordImport = (file: string, specifier: string) => {
    if (
      specifier.startsWith("node:") &&
      specifier !== "node:module" &&
      specifier !== "node:process"
    )
      return;
    if (specifier === "zod") return;
    if (!specifier.startsWith(".")) {
      violations.push(
        `${relative(root, file)} imports forbidden external module ${specifier}`,
      );
      return;
    }
    const target = resolveRelativeImport(file, specifier);
    if (target !== root && !target.startsWith(`${root}${sep}`))
      violations.push(
        `${relative(root, file)} imports outside core: ${specifier}`,
      );
  };

  const api = new API({ cwd: process.cwd() });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openFiles: files });
    const projects = snapshot.getProjects();
    for (const file of files) {
      const project = projects.find((candidate) =>
        candidate.program.getSourceFile(file),
      );
      const source = project?.program.getSourceFile(file);
      if (!source) {
        violations.push(`${relative(root, file)} was not parsed by TypeScript`);
        continue;
      }
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          recordImport(file, node.moduleSpecifier.text);
        }
        if (ts.isImportEqualsDeclaration(node)) {
          if (
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteral(node.moduleReference.expression)
          ) {
            recordImport(file, node.moduleReference.expression.text);
          } else if (ts.isExternalModuleReference(node.moduleReference)) {
            violations.push(
              `${relative(root, file)} has a non-literal import-equals`,
            );
          }
        }
        if (ts.isImportTypeNode(node)) {
          const argument = node.argument;
          if (
            ts.isLiteralTypeNode(argument) &&
            ts.isStringLiteral(argument.literal)
          ) {
            recordImport(file, argument.literal.text);
          } else {
            violations.push(
              `${relative(root, file)} has a non-literal import type`,
            );
          }
        }
        if (ts.isImportExpression(node)) {
          const call = ts.isCallExpression(node.parent)
            ? node.parent
            : undefined;
          const argument = call?.arguments[0];
          if (
            argument &&
            (ts.isStringLiteral(argument) ||
              ts.isNoSubstitutionTemplateLiteral(argument))
          ) {
            recordImport(file, argument.text);
          } else {
            violations.push(
              `${relative(root, file)} has a non-literal dynamic import`,
            );
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "getBuiltinModule"
        ) {
          violations.push(
            `${relative(root, file)} dynamically loads a Node built-in`,
          );
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "createRequire"
        ) {
          violations.push(`${relative(root, file)} uses createRequire()`);
        }
        if (
          ts.isCallExpression(node) &&
          ((ts.isIdentifier(node.expression) &&
            node.expression.text === "require") ||
            (ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "require"))
        ) {
          violations.push(`${relative(root, file)} uses require()`);
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  } finally {
    snapshot?.dispose();
    api.close();
  }
  return violations;
}

function fixture(files: Record<string, string>, check: (core: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-core-boundary-"));
  const core = join(directory, "src", "core");
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(core, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    check(core);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("production core imports stay inside core or use zod and node built-ins", () => {
  const violations = scanCoreGraph(resolve(process.cwd(), "src/core"));
  assert.deepEqual(violations, []);
});

test("core boundary checker accepts a core-to-core import chain", () => {
  fixture(
    {
      "index.ts": 'export { value } from "./helper.js";\n',
      "helper.ts":
        'import { createHash } from "node:crypto";\nimport { z } from "zod";\nimport { leaf } from "./leaf.js";\nexport const value = `${createHash} ${z} ${leaf}`;\n',
      "leaf.ts": "export const leaf = 'core';\n",
    },
    (core) => assert.deepEqual(scanCoreGraph(core), []),
  );
});

test("core boundary checker rejects direct, type-only, re-exported, helper, and dynamic BB dependencies", () => {
  fixture(
    {
      "direct.ts": 'import { z } from "@get-bb/plugin-sdk";\n',
      "type-only.ts":
        'import type { BbPluginApi } from "@get-bb/plugin-sdk";\n',
      "reexport.ts": 'export { plugin } from "..\/adapters\/bb\/plugin.js";\n',
      "index.ts": 'export { value } from "./helper.js";\n',
      "helper.ts":
        'import { value } from "..\/..\/adapters\/bb\/helper.js";\nexport { value };\n',
      "literal-dynamic.ts": 'void import("@get-bb/plugin-sdk");\n',
      "import-equals.ts": 'import SDK = require("@get-bb/plugin-sdk");\n',
      "import-type.ts":
        'type SDK = import("@get-bb/plugin-sdk").BbPluginApi;\n',
      "nonliteral-dynamic.ts": "void import(moduleName);\n",
      "require.ts": 'require("@get-bb/plugin-sdk");\n',
      "create-require.ts":
        'import { createRequire as loader } from "node:module";\nconst load = loader(import.meta.url);\nload("@get-bb/plugin-sdk");\n',
      "builtin-loader.ts": 'process.getBuiltinModule("module");\n',
      "valid.ts": 'import { leaf } from "./leaf.js";\nexport { leaf };\n',
      "leaf.ts": "export const leaf = 'core';\n",
    },
    (core) => {
      const violations = scanCoreGraph(core).join("\n");
      assert.match(violations, /forbidden external module @get-bb\/plugin-sdk/);
      assert.match(violations, /forbidden external module node:module/);
      assert.match(violations, /imports outside core/);
      assert.match(violations, /non-literal dynamic import/);
      assert.match(violations, /uses require\(\)/);
      assert.match(violations, /dynamically loads a Node built-in/);
    },
  );
});
