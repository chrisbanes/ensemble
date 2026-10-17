import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFixHref } from "../../web/src/wait-fix-href.js";
import {
  addClaudeHref,
  readinessCheckHref,
  SETTINGS_SECTIONS,
  settingsSectionHref,
  settingsSectionOrder,
} from "../../web/src/settings-sections.js";

const designed = [
  "projects",
  "runtime",
  "profiles",
  "routing",
  "github-discovery",
  "cli-credentials",
  "notifications",
  "readiness",
];

test("first run orders Readiness first and established installs keep the designed order", () => {
  assert.deepEqual(settingsSectionOrder(false), [
    "readiness",
    "projects",
    "runtime",
    "profiles",
    "routing",
    "github-discovery",
    "cli-credentials",
    "notifications",
  ]);
  assert.deepEqual(settingsSectionOrder(true), designed);
  assert.deepEqual(settingsSectionOrder(undefined), designed);
});

test("section hrefs are the Settings path with the section fragment", () => {
  for (const { id } of SETTINGS_SECTIONS)
    assert.equal(settingsSectionHref(id), `/app/settings#${id}`);
  assert.equal(
    readinessCheckHref("claude-executable"),
    "/app/settings#readiness-claude-executable",
  );
});

test("a wait's Fix opens the section that holds it, never bare Settings", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(waitFixHref({ kind: "readiness" }), "/app/settings#readiness");
  assert.equal(waitFixHref({ kind: "add-claude" }), addClaudeHref);
  assert.equal(addClaudeHref, "/app/settings/runtime#add-claude");
  for (const fix of [
    { kind: "choose-lead", projectId: id },
    { kind: "readiness" },
    { kind: "add-claude" },
    { kind: "open-profile", profileId: id },
    { kind: "open-repositories", projectId: id },
  ] as const)
    assert.notEqual(waitFixHref(fix), "/app/settings", fix.kind);
});
