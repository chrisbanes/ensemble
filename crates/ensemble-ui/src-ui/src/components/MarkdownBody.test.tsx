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
      <MarkdownBody>
        {[
          "```rust",
          "fn main() {",
          '    println!("hello");',
          "}",
          "```",
        ].join("\n")}
      </MarkdownBody>,
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
      <MarkdownBody>
        {"<script>alert('xss')</script><img src=x onerror=alert('xss') />"}
      </MarkdownBody>,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not create image DOM nodes from Markdown image syntax", () => {
    const { container } = render(
      <MarkdownBody>
        {"before ![tracking pixel](https://attacker.example/pixel) after"}
      </MarkdownBody>,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/before/)).toHaveTextContent("before after");
  });
});
