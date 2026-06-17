# Issue 226 Markdown Event Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render agent output event bodies in the dashboard timeline as safe Markdown without changing event chrome or non-agent metadata rendering.

**Architecture:** Add one reusable Markdown body component in the UI layer, backed by `react-markdown`, `remark-gfm`, and `rehype-sanitize`. Wire it into `EventTimeline` only for aggregated `output` events, because `WsEventData` currently has no explicit origin field and `output` is the agent message stream already grouped by run, step, and attempt. Keep all timestamps, labels, badges, and non-output detail fields as plain React text.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest, Testing Library, `react-markdown`, `remark-gfm`, `rehype-sanitize`, pnpm.

---

## File Structure

- Modify: `crates/ensemble-ui/src-ui/package.json`
  - Add Markdown renderer and sanitizer dependencies.
- Modify: `crates/ensemble-ui/src-ui/pnpm-lock.yaml`
  - Updated by `pnpm add`.
- Create: `crates/ensemble-ui/src-ui/src/components/MarkdownBody.tsx`
  - Focused renderer for untrusted Markdown text. No app-specific event logic.
- Create: `crates/ensemble-ui/src-ui/src/components/MarkdownBody.test.tsx`
  - Unit coverage for bullets, inline code, fenced code, links, and unsafe HTML/script input.
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
  - Replace the plain paragraph for `output` event details with `MarkdownBody`.
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx`
  - Add component tests proving output events render Markdown and non-output events stay plain text.

No product documentation update is expected unless implementation finds an existing dashboard behavior section that describes event body formatting. The plan itself documents the change for issue history.

---

### Task 1: Add Markdown Dependencies

**Files:**
- Modify: `crates/ensemble-ui/src-ui/package.json`
- Modify: `crates/ensemble-ui/src-ui/pnpm-lock.yaml`

- [ ] **Step 1: Add the renderer and sanitizer packages**

Run from the UI package:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm add react-markdown remark-gfm rehype-sanitize
```

Expected: `package.json` gains the three dependencies and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Confirm dependency entries**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm list react-markdown remark-gfm rehype-sanitize
```

Expected: all three packages are listed under `ensemble-dashboard`.

- [ ] **Step 3: Commit**

```bash
rtk git add crates/ensemble-ui/src-ui/package.json crates/ensemble-ui/src-ui/pnpm-lock.yaml
rtk git commit -m "build: add markdown rendering dependencies"
```

---

### Task 2: Create a Sanitized Markdown Renderer

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/MarkdownBody.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/MarkdownBody.test.tsx`

- [ ] **Step 1: Write the failing renderer tests**

Create `crates/ensemble-ui/src-ui/src/components/MarkdownBody.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

describe("MarkdownBody", () => {
  it("renders bullets and inline code", () => {
    render(<MarkdownBody>{"- first\n- run `cargo test`"}</MarkdownBody>);

    const list = screen.getByRole("list");
    expect(within(list).getByText("first")).toBeInTheDocument();
    expect(within(list).getByText("run")).toBeInTheDocument();
    expect(screen.getByText("cargo test").tagName).toBe("CODE");
  });

  it("renders fenced code blocks as scrollable code", () => {
    render(
      <MarkdownBody>{[
        "```rust",
        "fn main() {",
        "    println!(\"hello\");",
        "}",
        "```",
      ].join("\n")}</MarkdownBody>,
    );

    const code = screen.getByText(/println!\("hello"\)/);
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).toHaveClass("overflow-x-auto");
  });

  it("renders safe links with external-link protections", () => {
    render(<MarkdownBody>{"[docs](https://example.com/docs)"}</MarkdownBody>);

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("does not create executable DOM from unsafe HTML", () => {
    const { container } = render(
      <MarkdownBody>{"<script>alert('xss')</script><img src=x onerror=alert('xss') />"}</MarkdownBody>,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- MarkdownBody.test.tsx
```

Expected: FAIL because `./MarkdownBody` does not exist.

- [ ] **Step 3: Implement the renderer**

Create `crates/ensemble-ui/src-ui/src/components/MarkdownBody.tsx`:

```tsx
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownBodyProps {
  children: string;
  className?: string;
}

const components: Components = {
  a({ children, className, ...props }) {
    return (
      <a
        {...props}
        className={cn("text-primary underline underline-offset-2 hover:text-primary/80", className)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  code({ children, className, ...props }) {
    const isBlockCode = typeof className === "string" && className.startsWith("language-");

    return (
      <code
        {...props}
        className={cn(
          "font-mono",
          isBlockCode
            ? className
            : "rounded bg-muted px-1 py-0.5 text-[0.85em] text-foreground",
        )}
      >
        {children}
      </code>
    );
  },
  h1({ children }) {
    return <h1 className="mt-2 text-base font-semibold text-foreground first:mt-0">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mt-2 text-sm font-semibold text-foreground first:mt-0">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mt-2 text-sm font-semibold text-foreground first:mt-0">{children}</h3>;
  },
  li({ children }) {
    return <li className="pl-1">{children}</li>;
  },
  ol({ children }) {
    return <ol className="my-1 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>;
  },
  p({ children }) {
    return <p className="my-1 first:mt-0 last:mb-0">{children}</p>;
  },
  pre({ children }) {
    return (
      <pre className="my-2 max-h-72 overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground first:mt-0 last:mb-0">
        {children}
      </pre>
    );
  },
  ul({ children }) {
    return <ul className="my-1 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>;
  },
};

export function MarkdownBody({ children, className }: MarkdownBodyProps) {
  return (
    <div className={cn("min-w-0 break-words text-sm text-muted-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: Run the renderer tests**

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- MarkdownBody.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-ui/src-ui/src/components/MarkdownBody.tsx crates/ensemble-ui/src-ui/src/components/MarkdownBody.test.tsx
rtk git commit -m "feat: add sanitized markdown body renderer"
```

---

### Task 3: Render Agent Output Events as Markdown

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx`

- [ ] **Step 1: Write failing event timeline component tests**

Append these imports to `crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import EventTimeline from "./EventTimeline";
```

Append these tests after the existing `aggregateOutputEvents` suite:

```tsx
describe("EventTimeline Markdown rendering", () => {
  it("renders aggregated output event detail as Markdown", () => {
    render(
      <EventTimeline
        live={false}
        events={[
          makeEvent({
            type: "output",
            detail: "- finding one\n- run `cargo test`\n\n```text\nPASS\n```",
          }),
        ]}
      />,
    );

    expect(screen.getByText("finding one").closest("ul")).toHaveClass("list-disc");
    expect(screen.getByText("cargo test").tagName).toBe("CODE");
    expect(screen.getByText("PASS").closest("pre")).toHaveClass("overflow-x-auto");
  });

  it("does not render non-output event details as Markdown", () => {
    render(
      <EventTimeline
        live={false}
        events={[
          makeEvent({
            type: "step_started",
            detail: "- plain step text",
          }),
        ]}
      />,
    );

    expect(screen.getByText("- plain step text")).toBeInTheDocument();
    expect(screen.queryByText("plain step text")).not.toBeInTheDocument();
  });

  it("does not execute unsafe output event HTML", () => {
    const { container } = render(
      <EventTimeline
        live={false}
        events={[
          makeEvent({
            type: "output",
            detail: "<script>alert('xss')</script><img src=x onerror=alert('xss') />",
          }),
        ]}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- EventTimeline.test.tsx
```

Expected: FAIL because `output` details are still rendered as a plain paragraph and Markdown structures are absent.

- [ ] **Step 3: Import `MarkdownBody`**

In `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`, add:

```tsx
import { MarkdownBody } from "@/components/MarkdownBody";
```

- [ ] **Step 4: Add a helper for Markdown-eligible events**

In `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`, below `flushOutputBuffer`, add:

```tsx
function shouldRenderMarkdown(event: WsEventData): boolean {
  return event.type === "output";
}
```

- [ ] **Step 5: Replace only the event detail body rendering**

In `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`, replace:

```tsx
<p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p>
```

with:

```tsx
{shouldRenderMarkdown(event) ? (
  <MarkdownBody className="mt-0.5">{event.detail}</MarkdownBody>
) : (
  <p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p>
)}
```

- [ ] **Step 6: Run the focused event timeline tests**

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- EventTimeline.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx
rtk git commit -m "feat: render agent output events as markdown"
```

---

### Task 4: Verification and Documentation Check

**Files:**
- Inspect: `docs/SPEC.md`
- Inspect: `docs/configuration.md`
- Inspect: `docs/pipelines.md`
- Inspect: `docs/sdd-workflow.md`

- [ ] **Step 1: Run the UI test suite**

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run the UI build**

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm run build
```

Expected: PASS.

- [ ] **Step 3: Run Rust checks affected by generated UI build assumptions**

From the repo root:

```bash
rtk env SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
```

Expected: PASS.

- [ ] **Step 4: Check whether product docs mention event body formatting**

Run:

```bash
rtk proxy rg -n "event list|timeline|dashboard|Markdown|transcript" docs/SPEC.md docs/configuration.md docs/pipelines.md docs/sdd-workflow.md
```

Expected: no required docs update unless an existing section describes dashboard event body formatting. If there is a relevant section, update it to state that agent output events render sanitized Markdown while event chrome remains plain UI text.

- [ ] **Step 5: Final formatting and status**

Run:

```bash
rtk cargo fmt --all -- --check
rtk git status --short
```

Expected: formatting passes and `git status --short` shows only the intended UI dependency, renderer, event timeline, test, and optional docs changes.

- [ ] **Step 6: Commit optional docs update if needed**

Only run this if Step 4 found and updated relevant product docs:

```bash
rtk git add docs/SPEC.md docs/configuration.md docs/pipelines.md docs/sdd-workflow.md
rtk git commit -m "docs: document markdown event rendering"
```

---

## Self-Review

- Issue coverage: The plan formats agent-originated dashboard output bodies, preserves non-output details as plain text, keeps event metadata/chrome unchanged, sanitizes untrusted HTML input, and covers bullets, inline code, fenced code, links, plain text, and unsafe input.
- Scope check: The implementation intentionally does not change transcript views in this issue. The reusable `MarkdownBody` component makes transcript adoption straightforward later, but this plan keeps behavior scoped to the event list acceptance criteria.
- Layout check: The renderer avoids Tailwind typography plugin assumptions, applies compact margins, uses `break-words`, and keeps fenced code blocks horizontally scrollable with a max height.
- Docs check: Product docs are likely not required because current docs do not appear to specify event body presentation. The verification task still requires checking before completion.
