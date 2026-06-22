import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsShell } from "@/components/DocsShell";
import { Markdown } from "@/components/Markdown";
import { docSlugs, getAllDocs, getDoc, getNavGroups } from "@/lib/docs";
import { getHighlighter } from "@/lib/highlighter";

// Every docs page is statically generated; unknown slugs 404 rather than render.
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: [] as string[] }, ...getAllDocs().map((d) => ({ slug: [d.slug] }))];
}

type Params = { slug?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const s = slug?.[0];
  if (!s) {
    return {
      title: "Docs — Bunsen",
      description: "Documentation for Bunsen, a source-available research lab for agentic systems.",
    };
  }
  const doc = getDoc(s);
  if (!doc) return {};
  return {
    title: `${doc.meta.title} — Bunsen docs`,
    description: `${doc.meta.title} — documentation for Bunsen, a source-available research lab for agentic systems.`,
  };
}

export default async function DocsPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const groups = getNavGroups();
  const s = slug?.[0] ?? null;

  if (s === null) {
    return (
      <DocsShell groups={groups} activeSlug={null}>
        <article className="prose docs-overview">
          <h1>Documentation</h1>
          <p>
            Bunsen is an experiment runner for agentic systems: give an agent an environment, run it
            reproducibly, capture everything, and evaluate the result. New here? Start with{" "}
            <a href="/docs/introduction">Introduction</a>, then{" "}
            <a href="/docs/getting-started">Getting Started</a>.
          </p>
          {groups.map((g) => (
            <section className="docs-overview-group" key={g.group}>
              <h2>{g.group}</h2>
              <p className="docs-overview-blurb">{g.blurb}</p>
              <ul>
                {g.items.map((d) => (
                  <li key={d.slug}>
                    <a href={`/docs/${d.slug}`}>{d.title}</a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </article>
      </DocsShell>
    );
  }

  const doc = getDoc(s);
  if (!doc) notFound();

  const highlighter = await getHighlighter();
  return (
    <DocsShell groups={groups} activeSlug={s}>
      <article className="prose">
        <Markdown content={doc.content} highlighter={highlighter} slugs={docSlugs()} />
      </article>
    </DocsShell>
  );
}
