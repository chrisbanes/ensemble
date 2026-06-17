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
        className={cn(
          "text-primary underline underline-offset-2 hover:text-primary/80",
          className,
        )}
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
    const isBlockCode =
      typeof className === "string" && className.startsWith("language-");

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
    return (
      <h1 className="mt-2 text-base font-semibold text-foreground first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mt-2 text-sm font-semibold text-foreground first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mt-2 text-sm font-semibold text-foreground first:mt-0">
        {children}
      </h3>
    );
  },
  li({ children }) {
    return <li className="pl-1">{children}</li>;
  },
  ol({ children }) {
    return (
      <ol className="my-1 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">
        {children}
      </ol>
    );
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
    return (
      <ul className="my-1 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">
        {children}
      </ul>
    );
  },
};

export function MarkdownBody({ children, className }: MarkdownBodyProps) {
  return (
    <div
      className={cn(
        "min-w-0 break-words text-sm text-muted-foreground",
        className,
      )}
    >
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
