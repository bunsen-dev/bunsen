import type { ReactElement, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import type { Highlighter } from "shiki";

import { highlight } from "@/lib/highlighter";
import { rewriteHref } from "@/lib/docs";

/**
 * Renders a doc's markdown as a server component (build-time SSG, zero client JS):
 * - remark-gfm for tables / strikethrough / task lists
 * - rehype-slug so headings get ids that in-doc `#anchor` links resolve to
 * - fenced code blocks highlighted via the preloaded Shiki highlighter
 * - links rewritten so cross-doc `.md` refs resolve to `/docs/*`
 */
export function Markdown({
  content,
  highlighter,
  slugs,
}: {
  content: string;
  highlighter: Highlighter;
  slugs: Set<string>;
}) {
  const components: Components = {
    a({ href, children, node, ...props }) {
      void node;
      const to = rewriteHref(href, slugs);
      const external = /^https?:/i.test(to);
      const rel = external ? { target: "_blank", rel: "noreferrer" } : {};
      return (
        <a href={to} {...rel} {...props}>
          {children}
        </a>
      );
    },
    // Block code: react-markdown wraps fenced blocks in <pre><code>. We take over
    // <pre> and emit the Shiki HTML directly so inline `code` stays untouched.
    pre({ children }) {
      const codeEl = (Array.isArray(children) ? children[0] : children) as
        | ReactElement<{ className?: string; children?: ReactNode }>
        | undefined;
      const className = codeEl?.props?.className ?? "";
      const raw = codeEl?.props?.children;
      const code = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).replace(/\n$/, "");
      const lang = /language-(\w+)/.exec(className)?.[1];
      const html = highlight(highlighter, code, lang);
      return (
        <div className="codeblock" data-lang={lang ?? "text"} dangerouslySetInnerHTML={{ __html: html }} />
      );
    },
  };

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
