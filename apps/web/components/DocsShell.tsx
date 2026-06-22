import type { ReactNode } from "react";

import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import type { NavGroupResolved } from "@/lib/docs";

/**
 * Two-column docs chrome: a grouped sidebar plus the rendered content. The
 * sidebar is plain `<a>` links (no client JS); on mobile it collapses into a
 * native `<details>` disclosure. Active state is server-rendered from
 * `activeSlug`, so the whole route stays static. Grouping/ordering comes from
 * `lib/docs-nav.ts` (resolved via `getNavGroups()`).
 */
export function DocsShell({
  groups,
  activeSlug,
  children,
}: {
  groups: NavGroupResolved[];
  activeSlug: string | null;
  children: ReactNode;
}) {
  const nav = (
    <nav className="docs-nav">
      <a className={activeSlug === null ? "active" : undefined} href="/docs">
        Overview
      </a>
      {groups.map((g) => (
        <div className="docs-nav-group" key={g.group}>
          <p className="docs-nav-heading">{g.group}</p>
          {g.items.map((d) => (
            <a
              key={d.slug}
              className={d.slug === activeSlug ? "active" : undefined}
              href={`/docs/${d.slug}`}
            >
              {d.title}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <SiteHeader />
      <div className="docs-shell wrap">
        <aside className="docs-sidebar">
          <div className="docs-sidebar-desktop">{nav}</div>
          <details className="docs-sidebar-mobile">
            <summary>Documentation menu</summary>
            {nav}
          </details>
        </aside>
        <main className="docs-content">{children}</main>
      </div>
      <SiteFooter />
    </>
  );
}
