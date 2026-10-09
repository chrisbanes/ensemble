import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const test = browserSuite("ui08-files-preview");

function pdf(pageCount: number, pageWidth: number, pageHeight: number) {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from(
      { length: pageCount },
      (_, index) => `${3 + index} 0 R`,
    ).join(" ")}] /Count ${pageCount} >>`,
  ];
  const contentIds = Array.from(
    { length: pageCount },
    (_, index) => 3 + pageCount + index,
  );
  for (let page = 0; page < pageCount; page++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << >> /Contents ${contentIds[page]} 0 R >>`,
    );
  for (let page = 0; page < pageCount; page++) {
    const content =
      page === 0 ? `${"0 0 1 1 re f\n".repeat(60_000)}\n` : `0 0 1 1 re f\n`;
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }

  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const crossReferenceOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF`;
  return Buffer.from(source);
}

function pngImage(width = 1, height = 1) {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name, "ascii");
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    type.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 4;
      rows[offset] = (x + y) % 256;
      rows[offset + 1] = (x * 3 + y) % 256;
      rows[offset + 2] = (x + y * 5) % 256;
      rows[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sourceRepository(
  root: string,
  name: string,
  files: Record<string, string>,
) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.name",
    "Files Browser Test",
  ]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "files-browser@example.invalid",
  ]);
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(path, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-C", path, "add", ".gitignore", ...Object.keys(files)]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "Files fixture"]);
  return path;
}

function guideMarkdown(version: string) {
  const longBody = Array.from(
    { length: 72 },
    (_, index) => `Generated detail ${index + 1}: ${version}.`,
  ).join("\n\n");
  return `# Alpha Guide\n\n## Current ${version}\n\nA **bold** and \`inline-code\` example.\n\n- alpha\n  - nested item\n- beta\n\n| Name | Value |\n| --- | --- |\n| mode | ${version} |\n\n[external link](https://example.invalid/private)\n\n![remote image](https://example.invalid/remote.png)\n\n<script>window.filePreviewInjected = true</script>\n\n<img src="https://example.invalid/raw.png" onerror="window.filePreviewInjected = true">\n\n[unsafe link](javascript:window.filePreviewInjected = true)\n\n${longBody}\n`;
}

test("production Files reads service PDF bytes and bounds page, canvas and cancellation behavior on phone", async (_t, j) => {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const task = await seedReviewTask(fixture, "Files preview test");
  const binding = await fixture.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  const bytes = pdf(12, 1000, 60_000);
  const rasterBytes = pngImage();
  writeFileSync(join(binding.path, "oversized-12-pages.pdf"), bytes);
  writeFileSync(join(binding.path, "sample.png"), rasterBytes);
  writeFileSync(
    join(binding.path, "literal.txt"),
    "<script>window.filePreviewInjected = true</script>",
  );
  const web = await j.start("fixture.web", () => fixture.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  await page.clock.install();

  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const workerUrls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== web.origin)
      externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("worker", (worker) => workerUrls.push(worker.url()));

  const appResponse = await page.goto(
    `${web.origin}/app/tasks/${task.taskId}?section=files`,
  );
  const policy = appResponse?.headers()["content-security-policy"] ?? "";
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /img-src 'self' data:/);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();

  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/operator/tasks/${task.taskId}/preview?`),
  );
  const pdfButton = page.getByRole("button", {
    name: /oversized-12-pages\.pdf/,
  });
  await pdfButton.focus();
  await page.keyboard.press("Enter");
  const serviceResponse = await responsePromise;
  assert.equal(serviceResponse.status(), 200);
  const payload = (await serviceResponse.json()) as {
    data: {
      state: string;
      preview: {
        mime: string;
        data: string;
        size: number;
        sha256: string;
        maxDisplayedPages: number;
        maxCanvasPixels: number;
      };
    };
  };
  assert.equal(payload.data.state, "ready");
  assert.equal(payload.data.preview.mime, "application/pdf");
  assert.equal(payload.data.preview.data, bytes.toString("base64"));
  assert.equal(payload.data.preview.size, bytes.byteLength);
  assert.equal(
    payload.data.preview.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(payload.data.preview.maxDisplayedPages, 10);
  assert.equal(payload.data.preview.maxCanvasPixels, 16_000_000);

  const pageOneCanvas = page.locator('canvas[aria-label="PDF page 1"]');
  await pageOneCanvas.waitFor();
  assert.equal(
    await pageOneCanvas.getAttribute("data-render-state"),
    "pending",
  );
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.locator('canvas[aria-label="PDF page 2"]').waitFor();
  await page
    .locator('canvas[aria-label="PDF page 2"][data-render-state="ready"]')
    .waitFor();
  assert.equal(await page.locator("canvas").count(), 1);

  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  for (let zoom = 0; zoom < 4; zoom++)
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page
    .locator('canvas[aria-label="PDF page 1"][data-render-state="ready"]')
    .waitFor();
  const dimensions = await page.locator("canvas").evaluateAll((canvases) =>
    canvases.map((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        pixels: canvas.width * canvas.height,
        max: Number(canvas.dataset.maxCanvasPixels),
        page: Number(canvas.dataset.pageNumber),
      };
    }),
  );
  assert.equal(dimensions.length, 1);
  assert.equal(dimensions[0]?.page, 1);
  assert.ok(dimensions[0]!.pixels <= dimensions[0]!.max);
  assert.ok(dimensions[0]!.max <= payload.data.preview.maxCanvasPixels);
  // The scaled-render notice replaces "Rendering page…" once the canvas settles.
  await page
    .locator(".pdf-preview")
    .getByText(/scaled down to stay within the 16,000,000-pixel preview cap/)
    .waitFor();

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  for (let pageNumber = 3; pageNumber <= 10; pageNumber++)
    await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page
    .locator('canvas[aria-label="PDF page 10"][data-render-state="ready"]')
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Next page", exact: true })
      .isDisabled(),
    true,
  );
  await captureBrowserEvidence(page, "390-bounded-pdf-preview", {
    fullPage: false,
  });

  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  await page.getByRole("button", { name: /literal\.txt/ }).focus();
  await page.keyboard.press("Space");
  await page
    .getByText("<script>window.filePreviewInjected = true</script>", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(await page.locator(".file-line-text").allTextContents(), [
    "<script>window.filePreviewInjected = true</script>",
  ]);
  assert.equal(await page.locator("canvas").count(), 0);
  assert.equal(
    await page.evaluate(
      () =>
        (window as Window & { filePreviewInjected?: boolean })
          .filePreviewInjected,
    ),
    undefined,
  );
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  const imageButton = page.getByRole("button", { name: /sample\.png/ });
  await imageButton.focus();
  await page.keyboard.press("Enter");
  const image = page.locator(".file-image-preview");
  await image.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>(".file-image-preview")
        ?.naturalWidth === 1,
  );
  assert.equal(
    await image.evaluate(
      (element) => (element as HTMLImageElement).naturalHeight,
    ),
    1,
  );
  assert.equal(
    await page.locator("a[download], object, embed, iframe").count(),
    0,
  );
  assert.ok(workerUrls.some((url) => url.includes("pdf.worker")));
  assert.ok(workerUrls.every((url) => new URL(url).origin === web.origin));
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(consoleErrors, []);
});

test("production Files keeps scoped previews stable, inert and navigable across repositories on phone and desktop", async (_t, j) => {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );

  const longName =
    "this-is-a-very-long-generated-guide-name-that-must-stay-on-one-line-and-disclose-its-full-path.md";
  const alphaSource = sourceRepository(
    join(fixture.directory, "sources"),
    "alpha",
    {
      "guide.md": guideMarkdown("stable"),
      "gone.txt": "This file will be removed after its first preview.\n",
      "docs/child.txt": "Arrow key folder child.\n",
      "example.ts": 'export const answer = 42;\nconsole.log("source only");\n',
      "unsafe.svg":
        "<svg><script>window.filePreviewInjected = true</script></svg>\n",
      [longName]: "long filename fixture\n",
    },
  );
  const betaSource = sourceRepository(
    join(fixture.directory, "sources"),
    "beta",
    {
      "beta.txt": "BETA_ONLY repository content\n",
    },
  );
  const task = await seedReviewTask(
    fixture,
    "Files repository scopes",
    "Inspect repository previews",
    "Verify exact scoped read-only content",
    [
      { repositoryId: "alpha", path: alphaSource },
      { repositoryId: "beta", path: betaSource },
    ],
  );
  const binding = await fixture.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  const alpha = binding.repositories.find(
    (repository) => repository.repositoryId === "alpha",
  );
  const beta = binding.repositories.find(
    (repository) => repository.repositoryId === "beta",
  );
  assert.ok(alpha);
  assert.ok(beta);
  const alphaGuide = join(alpha.workspacePath, "guide.md");
  const controlFile = join(alpha.workspacePath, "credentials.txt");
  writeFileSync(
    join(alpha.workspacePath, "hidden.log"),
    "VISIBLE_IGNORED_FIXTURE\n",
  );
  writeFileSync(controlFile, "DUMMY_CONTROL_PATH_VALUE\n");
  writeFileSync(
    join(alpha.workspacePath, "overview.png"),
    pngImage(1600, 1000),
  );

  const web = await j.start("fixture.web", () =>
    fixture.startWeb([fixture.directory, controlFile]),
  );
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(15_000);

  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const expected503ConsoleErrors: Array<{
    text: string;
    url: string;
    observedAt: number;
  }> = [];
  const previewPaths: string[] = [];
  let expected503Window = false;
  let controlledFailureUrl: string | null = null;
  let expected503WindowStartedAt = 0;
  let expected503WindowEndedAt = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== web.origin) externalRequests.push(request.url());
    if (url.pathname.endsWith("/preview"))
      previewPaths.push(url.searchParams.get("path") ?? "");
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    if (expected503Window && /\b503\b/.test(message.text()))
      expected503ConsoleErrors.push({
        text: message.text(),
        url: location.url,
        observedAt: Date.now(),
      });
    else consoleErrors.push(message.text());
  });

  const appResponse = await page.goto(
    `${web.origin}/app/tasks/${task.taskId}?section=files`,
  );
  assert.match(
    appResponse?.headers()["content-security-policy"] ?? "",
    /img-src 'self' data:/,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();

  const alphaRootButton = page.getByRole("button", {
    name: /alpha, repository, full path Repository alpha/,
  });
  await alphaRootButton.waitFor();
  assert.equal(await alphaRootButton.count(), 1);
  assert.equal(
    await alphaRootButton.evaluate((element) =>
      Math.round(element.getBoundingClientRect().height),
    ),
    44,
  );
  await alphaRootButton.focus();
  await page.keyboard.press("ArrowRight");
  const guideButton = page.getByRole("button", { name: /guide\.md/ });
  await guideButton.waitFor();
  const explorerLabels = await page
    .locator(".file-entry")
    .evaluateAll((entries) =>
      entries.map((entry) => entry.getAttribute("aria-label")),
    );
  const guideIndex = explorerLabels.findIndex((label) =>
    label?.includes("guide.md"),
  );
  assert.ok(guideIndex >= 0 && guideIndex + 1 < explorerLabels.length);
  await guideButton.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (expected) =>
      document.activeElement?.getAttribute("aria-label") === expected,
    explorerLabels[guideIndex + 1],
  );
  const docsButton = page.getByRole("button", { name: /docs, directory/ });
  await docsButton.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: /child\.txt/ }).waitFor();
  await page.keyboard.press("ArrowLeft");
  await docsButton.waitFor();
  await page.waitForFunction(() =>
    document.activeElement
      ?.getAttribute("aria-label")
      ?.includes("docs, directory"),
  );
  await page.keyboard.press("ArrowLeft");
  await alphaRootButton.waitFor();
  await page.waitForFunction(() =>
    document.activeElement
      ?.getAttribute("aria-label")
      ?.includes("full path Repository alpha"),
  );
  await page.keyboard.press("ArrowRight");
  await guideButton.waitFor();
  assert.equal(
    await page.getByRole("button", { name: /hidden\.log/ }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: /credentials\.txt/ }).count(),
    0,
  );
  const longEntry = page.getByRole("button", { name: new RegExp(longName) });
  assert.equal(
    await longEntry.getAttribute("title"),
    `Repository alpha/${longName}`,
  );
  const longNameStyle = await longEntry
    .locator(".file-entry-name")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow };
    });
  assert.deepEqual(longNameStyle, {
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  });

  const stableGuide = guideMarkdown("stable");
  const stableHash = createHash("sha256").update(stableGuide).digest("hex");
  const firstGuideResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "guide.md"
    );
  });
  await guideButton.click();
  const firstGuidePayload = (await (await firstGuideResponse).json()) as {
    data: {
      state: string;
      preview?: { kind: string; text?: string; sha256?: string };
    };
  };
  assert.equal(firstGuidePayload.data.state, "ready");
  assert.equal(firstGuidePayload.data.preview?.kind, "text");
  assert.equal(firstGuidePayload.data.preview?.text, stableGuide);
  assert.equal(firstGuidePayload.data.preview?.sha256, stableHash);
  await page
    .getByRole("heading", { name: "Alpha Guide", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Current stable", exact: true })
    .waitFor();
  assert.equal(await page.locator(".file-markdown strong").innerText(), "bold");
  assert.equal(
    await page.locator(".file-markdown code").innerText(),
    "inline-code",
  );
  assert.equal(await page.locator(".file-markdown ul ul").count(), 1);
  assert.equal(await page.locator(".file-markdown table tbody tr").count(), 1);
  assert.equal(
    await page
      .locator(".file-markdown a, .file-markdown img, .file-markdown script")
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      () =>
        (window as Window & { filePreviewInjected?: boolean })
          .filePreviewInjected,
    ),
    undefined,
  );
  assert.equal(
    await page.getByRole("link", { name: /external link|unsafe link/ }).count(),
    0,
  );
  await page.locator("summary").getByText("Full path", { exact: true }).click();
  assert.equal(
    await page.locator(".file-preview details code").innerText(),
    "Repository alpha/guide.md",
  );

  await page.getByRole("button", { name: "Source", exact: true }).click();
  const wrapButton = page.getByRole("button", { name: "Wrap", exact: true });
  assert.equal(await wrapButton.getAttribute("aria-pressed"), "false");
  await wrapButton.click();
  assert.equal(await wrapButton.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".file-source-scroll.is-wrapped").count(), 1);
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    stableGuide.replace(/\n$/, "").split("\n"),
  );
  const stableLine = page.getByRole("button", {
    name: "Line 3: ## Current stable",
  });
  await stableLine.click();
  assert.equal(await stableLine.getAttribute("aria-pressed"), "true");

  // Phone range selection without Shift: labelled 44px Start/End controls.
  const setStart = page.getByRole("button", { name: "Set start", exact: true });
  const setEnd = page.getByRole("button", { name: "Set end", exact: true });
  for (const control of [setStart, setEnd])
    assert.ok(
      (await control.evaluate(
        (element) => element.getBoundingClientRect().height,
      )) >= 44,
    );
  await setStart.click();
  await page.getByText("Edge fixed at line 3.", { exact: false }).waitFor();
  assert.equal(await setStart.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: /^Line 5: A \*\*bold\*\*/ }).click();
  await setEnd.click();
  await page.getByText("Selected lines 3–5", { exact: true }).waitFor();
  for (const [name, pressed] of [
    [/^Line 2 \(blank\)/, "false"],
    [/^Line 3:/, "true"],
    [/^Line 4 \(blank\)/, "true"],
    [/^Line 5:/, "true"],
    [/^Line 6 \(blank\)/, "false"],
  ] as const)
    assert.equal(
      await page.getByRole("button", { name }).getAttribute("aria-pressed"),
      pressed,
    );
  // The composer returns focus to the selected line of this origin only.
  const returnTargets = await page
    .locator('[data-review-return^="files:"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    );
  assert.equal(returnTargets.length, 1);
  assert.match(returnTargets[0] ?? "", /^Line 5: A \*\*bold\*\*/);
  // Ending the range returns to ordinary selection: a plain tap replaces it.
  await page.getByRole("button", { name: /^Line 5:/ }).click();
  await page.getByText("Selected lines 5–5", { exact: true }).waitFor();
  await stableLine.click();
  await page.getByText("Selected lines 3–3", { exact: true }).waitFor();
  await captureBrowserEvidence(page, "390-files-range-controls-phone", {
    fullPage: false,
  });
  const previewScroll = page.locator(".file-preview-scroll");
  await previewScroll.evaluate((element) => element.scrollTo(0, 500));
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-preview-scroll")?.scrollTop ?? 0) >= 450,
  );
  await captureBrowserEvidence(page, "390-files-markdown-source-phone", {
    fullPage: false,
  });
  assert.equal(await page.locator(".file-rail").isVisible(), false);
  assert.equal(await page.locator(".file-reading-area").isVisible(), true);
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  assert.equal(await page.locator(".file-rail").isVisible(), true);
  assert.equal(await page.locator(".file-reading-area").isVisible(), false);
  await page.getByRole("button", { name: /guide\.md/ }).click();
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-preview-scroll")?.scrollTop ?? 0) >= 450,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current stable" })
      .getAttribute("aria-pressed"),
    "true",
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(
    Math.round((await page.locator(".file-rail").boundingBox())?.width ?? 0),
    238,
  );
  await page.getByRole("toolbar", { name: "Open file tabs" }).waitFor();
  await page.getByRole("navigation", { name: "File path" }).waitFor();
  await captureBrowserEvidence(page, "1280-files-workbench-desktop", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  const refreshedGuide = guideMarkdown("refreshed");
  const refreshedHash = createHash("sha256")
    .update(refreshedGuide)
    .digest("hex");
  const firstGuideReads = previewPaths.filter(
    (path) => path === "guide.md",
  ).length;
  writeFileSync(alphaGuide, refreshedGuide);
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current stable" })
      .count(),
    1,
  );
  assert.equal(
    previewPaths.filter((path) => path === "guide.md").length,
    firstGuideReads,
  );
  await page.getByText(new RegExp(stableHash)).waitFor();
  const refreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "guide.md"
    );
  });
  await page
    .getByRole("button", { name: "Refresh selected file", exact: true })
    .click();
  const refreshedPayload = (await (await refreshResponse).json()) as {
    data: { state: string; preview?: { text?: string; sha256?: string } };
  };
  assert.equal(refreshedPayload.data.state, "ready");
  assert.equal(refreshedPayload.data.preview?.text, refreshedGuide);
  assert.equal(refreshedPayload.data.preview?.sha256, refreshedHash);
  await page
    .getByRole("button", { name: "Line 3: ## Current refreshed" })
    .waitFor();
  assert.equal(
    (await page.locator(".file-change-notice").innerText()).startsWith(
      `Changed since previous observation: SHA-256 ${stableHash.slice(0, 8)} → ${refreshedHash.slice(0, 8)}`,
    ),
    true,
  );

  const latestGuide = guideMarkdown("latest-unobserved");
  writeFileSync(alphaGuide, latestGuide);
  let signalFailureRequest!: () => void;
  const failureRequestSeen = new Promise<void>((resolve) => {
    signalFailureRequest = resolve;
  });
  let releaseFailureResponse!: () => void;
  const failureResponseGate = new Promise<void>((resolve) => {
    releaseFailureResponse = resolve;
  });
  await page.route(
    /\/api\/operator\/tasks\/[^/]+\/preview\?.*path=guide\.md/,
    async (route) => {
      controlledFailureUrl = route.request().url();
      signalFailureRequest();
      await failureResponseGate;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "temporarily unavailable",
      });
    },
  );
  const failedRefreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "guide.md" &&
      response.status() === 503
    );
  });
  const inspectReadingArea = () =>
    page.locator(".file-preview-scroll").evaluate((element) => {
      const viewport = element as HTMLElement;
      const bounds = viewport.getBoundingClientRect();
      const visibleLine = Array.from(
        viewport.querySelectorAll<HTMLElement>(".file-source-line"),
      )
        .map((line) => ({
          label: line.getAttribute("aria-label"),
          top: line.getBoundingClientRect().top - bounds.top,
          bottom: line.getBoundingClientRect().bottom - bounds.top,
        }))
        .find((line) => line.bottom > 0 && line.top < bounds.height);
      return {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        top: Math.round(bounds.top),
        height: Math.round(bounds.height),
        summary: viewport.innerText.slice(0, 320),
        sourceLineCount: viewport.querySelectorAll(".file-line-text").length,
        notice: viewport.querySelector('[role="alert"]')?.textContent ?? null,
        visibleLine: visibleLine
          ? { label: visibleLine.label, top: visibleLine.top }
          : null,
      };
    });
  const beforeFailedRefresh = await inspectReadingArea();
  const scrollBeforeFailedRefresh = beforeFailedRefresh.scrollTop;
  expected503Window = true;
  expected503WindowStartedAt = Date.now();
  await page
    .getByRole("button", { name: "Refresh selected file", exact: true })
    .click();
  await failureRequestSeen;
  const afterClickBeforeResponse = await inspectReadingArea();
  _t.diagnostic(
    `reading area before failed refresh: ${JSON.stringify(beforeFailedRefresh)}; after click while exact refresh request is held: ${JSON.stringify(afterClickBeforeResponse)}`,
  );
  releaseFailureResponse();
  assert.equal(afterClickBeforeResponse.scrollTop, scrollBeforeFailedRefresh);
  const failedResponse = await failedRefreshResponse;
  assert.equal(failedResponse.status(), 503);
  assert.equal(failedResponse.url(), controlledFailureUrl);
  await page
    .getByRole("alert")
    .getByText(/last successful preview is retained/)
    .waitFor();
  expected503WindowEndedAt = Date.now();
  expected503Window = false;
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current refreshed" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current latest-unobserved" })
      .count(),
    0,
  );
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    refreshedGuide.replace(/\n$/, "").split("\n"),
  );
  await page.getByText(new RegExp(refreshedHash)).waitFor();
  const afterFailedRefresh = await inspectReadingArea();
  _t.diagnostic(
    `reading area after confirmed 503 and retained-preview notice: ${JSON.stringify(afterFailedRefresh)}`,
  );
  assert.equal(
    afterFailedRefresh.visibleLine?.label,
    beforeFailedRefresh.visibleLine?.label,
  );
  assert.ok(beforeFailedRefresh.visibleLine);
  assert.ok(afterFailedRefresh.visibleLine);
  assert.ok(
    Math.abs(
      afterFailedRefresh.visibleLine.top - beforeFailedRefresh.visibleLine.top,
    ) <= 1,
  );
  assert.ok(expected503ConsoleErrors.length <= 1);
  for (const consoleError of expected503ConsoleErrors) {
    assert.equal(consoleError.url, controlledFailureUrl);
    assert.match(consoleError.text, /\b503\b/);
    assert.ok(consoleError.observedAt >= expected503WindowStartedAt);
    assert.ok(consoleError.observedAt <= expected503WindowEndedAt);
  }
  _t.diagnostic(
    `controlled guide.md refresh returned 503 at ${controlledFailureUrl}; retained SHA-256 ${refreshedHash}; exact in-window Chromium error events ${JSON.stringify(expected503ConsoleErrors)}`,
  );
  await page.unroute(
    /\/api\/operator\/tasks\/[^/]+\/preview\?.*path=guide\.md/,
  );

  const betaHash = createHash("sha256")
    .update("BETA_ONLY repository content\n")
    .digest("hex");
  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /beta, repository, full path Repository beta/,
    })
    .click();
  const betaRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "beta.txt"
    );
  });
  await page.getByRole("button", { name: /beta\.txt/ }).click();
  const betaPayload = (await (await betaRead).json()) as {
    data: { preview?: { text?: string; sha256?: string } };
  };
  assert.equal(
    betaPayload.data.preview?.text,
    "BETA_ONLY repository content\n",
  );
  assert.equal(betaPayload.data.preview?.sha256, betaHash);
  await page.getByText(new RegExp(betaHash)).waitFor();
  const betaReads = previewPaths.filter((path) => path === "beta.txt").length;

  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("button", { name: /guide\.md/ }).click();
  await page.getByText(new RegExp(refreshedHash)).waitFor();
  const afterCachedReturn = await inspectReadingArea();
  _t.diagnostic(
    `reading area after cached A→B→A return cleared the refresh notice: ${JSON.stringify(afterCachedReturn)}`,
  );
  assert.equal(afterCachedReturn.notice, null);
  assert.equal(
    afterCachedReturn.visibleLine?.label,
    beforeFailedRefresh.visibleLine?.label,
  );
  assert.ok(afterCachedReturn.visibleLine);
  assert.ok(beforeFailedRefresh.visibleLine);
  assert.ok(
    Math.abs(
      afterCachedReturn.visibleLine.top - beforeFailedRefresh.visibleLine.top,
    ) <= 1,
  );
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    refreshedGuide.replace(/\n$/, "").split("\n"),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current refreshed" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current refreshed" })
      .count(),
    1,
  );
  assert.equal(
    previewPaths.filter((path) => path === "guide.md").length,
    firstGuideReads + 2,
  );
  assert.equal(
    previewPaths.filter((path) => path === "beta.txt").length,
    betaReads,
  );

  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  const codeText = 'export const answer = 42;\nconsole.log("source only");\n';
  const codeRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "example.ts"
    );
  });
  await page.getByRole("button", { name: /example\.ts/ }).click();
  const codePayload = (await (await codeRead).json()) as {
    data: {
      state: string;
      preview?: { kind?: string; text?: string; sha256?: string };
    };
  };
  const codeHash = createHash("sha256").update(codeText).digest("hex");
  assert.equal(codePayload.data.state, "ready");
  assert.equal(codePayload.data.preview?.kind, "text");
  assert.equal(codePayload.data.preview?.text, codeText);
  assert.equal(codePayload.data.preview?.sha256, codeHash);
  await page.getByText(new RegExp(codeHash)).waitFor();
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    codeText.replace(/\n$/, "").split("\n"),
  );
  assert.equal(await page.locator("pre code, .file-markdown").count(), 0);

  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  const unsupportedRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "unsafe.svg"
    );
  });
  await page.getByRole("button", { name: /unsafe\.svg/ }).click();
  const unsupportedPayload = (await (await unsupportedRead).json()) as {
    data: {
      state: string;
      metadata?: { reason?: string };
      preview?: unknown;
    };
  };
  assert.equal(unsupportedPayload.data.state, "metadata-only");
  assert.equal(unsupportedPayload.data.metadata?.reason, "unsupported-format");
  assert.equal(unsupportedPayload.data.preview, undefined);
  await page
    .getByRole("status")
    .getByText(/Preview is metadata-only \(unsupported-format\)/)
    .waitFor();
  assert.equal(
    await page
      .locator(
        ".file-preview-scroll svg, .file-preview-scroll script, .file-preview-scroll img",
      )
      .count(),
    0,
  );
  assert.equal(
    (await page.locator(".file-preview-scroll").innerText()).includes(
      "window.filePreviewInjected",
    ),
    false,
  );

  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("button", { name: /gone\.txt/ }).click();
  await page
    .getByText("This file will be removed after its first preview.")
    .waitFor();
  unlinkSync(join(alpha.workspacePath, "gone.txt"));
  await page
    .getByRole("button", { name: "Refresh selected file", exact: true })
    .click();
  await page
    .getByRole("status")
    .getByText(/Preview is missing/)
    .waitFor();
  await page
    .locator(".file-change-notice")
    .getByText(/^No longer readable since previous observation: .*now missing/)
    .waitFor();

  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page
    .getByRole("button", { name: "Show ignored files", exact: true })
    .click();
  const ignoredButton = page.getByRole("button", { name: /hidden\.log/ });
  await ignoredButton.waitFor();
  await ignoredButton.click();
  await page.getByText("VISIBLE_IGNORED_FIXTURE", { exact: true }).waitFor();
  const excludedResponse = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, `${web.origin}/api/operator/tasks/${task.taskId}/preview?scope=repository&repositoryId=alpha&path=credentials.txt&showIgnored=true`);
  assert.equal(excludedResponse.status, 200);
  assert.match(excludedResponse.body, /"state":"excluded"/);
  assert.equal(
    excludedResponse.body.includes("DUMMY_CONTROL_PATH_VALUE"),
    false,
  );
  assert.equal(excludedResponse.body.includes(alphaSource), false);

  await page
    .getByRole("button", { name: "Workspace root", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("button", { name: /overview\.png/ }).click();
  const image = page.locator(".file-image-preview");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>(".file-image-preview")
        ?.naturalWidth === 1600,
  );
  assert.equal(
    await image.evaluate(
      (element) => (element as HTMLImageElement).naturalHeight,
    ),
    1000,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Fit", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Fit", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  const imageScroll = page.locator(".file-image-scroll");
  const imageBounds = await imageScroll.evaluate((element) => {
    const viewport = element as HTMLElement;
    return {
      scrollWidth: viewport.scrollWidth,
      clientWidth: viewport.clientWidth,
    };
  });
  assert.ok(imageBounds.scrollWidth > imageBounds.clientWidth);
  await imageScroll.evaluate((element) => element.scrollTo(120, 0));
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-image-scroll")?.scrollLeft ?? 0) >= 100,
  );
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  await page.getByRole("button", { name: /guide\.md/ }).click();
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  await page.getByRole("button", { name: /overview\.png/ }).click();
  await page.getByText("150%", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-image-scroll")?.scrollLeft ?? 0) >= 100,
  );
  await captureBrowserEvidence(page, "390-files-raster-pan-phone", {
    fullPage: false,
  });

  assert.equal(
    await page.locator("a[download], object, embed, iframe").count(),
    0,
  );
  // A nested file opens with literal slash separators (the service rejects
  // %2F), and a final newline does not add a phantom line.
  const nestedRead = page.waitForResponse(
    (response) =>
      response.url().includes("/preview?") &&
      response.url().includes("&path=docs/child.txt"),
  );
  await page.goto(
    `${web.origin}/app/tasks/${task.taskId}?section=files&repository=alpha&path=docs/child.txt`,
  );
  assert.equal((await nestedRead).status(), 200);
  await page
    .getByRole("button", { name: "Line 1: Arrow key folder child." })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: /^Line 2/ }).count(), 0);

  assert.deepEqual(externalRequests, []);
  assert.deepEqual(consoleErrors, []);
  assert.equal(
    (await page.locator("body").innerText()).includes(alphaSource),
    false,
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(betaSource),
    false,
  );
});
