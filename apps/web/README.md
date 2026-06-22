# @bunsen-dev/web

The Bunsen landing page — deployed at [bunsen.dev](https://bunsen.dev).

A Next.js app (App Router, React 19) with a dark terminal aesthetic: a hero with
an animated `bn run` line, the three pillars, a quickstart, the deep-evals
ladder, an at-scale benchmark matrix, the lab idea, a final CTA with an email
capture, and an in-app `/docs` route. Styling is authored CSS in
`app/globals.css` (ported from the design source); fonts come from `next/font`.

**No client components / no client JS.** Every page is server-rendered. The
homepage `/` is dynamically rendered (it reads the post-submit waitlist status
from `searchParams`); the `/docs/*` pages are statically generated (SSG). The
waitlist uses a Server Action, so it works with JS disabled and the API key never
reaches the browser. Server-only modules (`lib/waitlist.ts`'s Buttondown call,
`lib/docs.ts`'s `fs` reader, `lib/highlighter.ts`'s Shiki) are guarded with
`import "server-only"` so they can't be pulled into a client bundle.

## Develop

```bash
pnpm install                  # from the repo root (pnpm workspace)
pnpm --filter @bunsen-dev/web dev # http://localhost:3000
```

Other scripts: `build`, `start`, `typecheck`, `test`, `check:schemas`. `dev` and
`build` first run `scripts/sync-schemas.mjs` (see Schemas below).

## Docs (`/docs`)

`/docs/[[...slug]]` renders the repo-root `docs/*.md` files as static pages:

- `lib/docs.ts` discovers the files, derives slugs/titles, and rewrites cross-doc
  links (`./SCORERS.md` → `/docs/scorers`; other repo-relative links → GitHub blob).
- `components/Markdown.tsx` renders with `react-markdown` + `remark-gfm`
  (tables/etc.) + `rehype-slug` (heading anchors). Fenced code is highlighted with
  Shiki via a build-time highlighter (`lib/highlighter.ts`) — zero client JS.
- `components/DocsShell.tsx` is the two-column chrome; the sidebar is generated
  from the docs tree and collapses into a `<details>` disclosure on mobile.

Add a doc by dropping a `.md` file in the repo-root `docs/` — it appears
automatically (slug = lowercased filename, title = first `# H1`).

## Waitlist / updates capture

The final CTA captures emails for releases + early access to the hosted lab (one
Buttondown list, no segmentation at v1). It is **not** a gate on the CLI — the
tool is free and source-available.

- `components/WaitlistForm.tsx` is a plain `<form>` posting to the `subscribe`
  Server Action in `app/actions.ts`.
- `lib/waitlist.ts` calls the Buttondown API server-side using
  `BUTTONDOWN_API_KEY` (never exposed to the client). Already-subscribed is
  treated as success.
- The action redirects to `/?waitlist=<status>#waitlist`; the page reads it and
  renders the success / error state. Without an API key the form shows a "briefly
  unavailable" message (so local dev degrades gracefully).

## Schemas (`schemas.bunsen.dev`)

`scripts/sync-schemas.mjs` copies the four canonical JSON schemas from
`packages/types/schemas/*.v1.json` into `public/` (gitignored) at build time —
`packages/types` is the single source of truth, so the served bytes are the
canonical bytes by construction. They serve as static assets at the site root
(e.g. `/experiment.v1.json`); `schemas.bunsen.dev` is a plain domain alias of the
same project, so `https://schemas.bunsen.dev/experiment.v1.json` resolves to the
same file with `application/json` (automatic for `.json`). `next.config.ts` adds
open CORS to the four `*.v1.json` files — no rewrite, no host-aware routing — so
editor `$schema` fetches from other origins succeed.

`node scripts/sync-schemas.mjs --check` (run by the **Schemas** GitHub workflow
and `pnpm check:schemas`) fails if any schema is missing, is invalid JSON, or has
a `$id` that no longer matches its frozen URL — the `.v1.json` ids are frozen, so
a schema change becomes `v2`, never an in-place edit.

## CTAs

"View on GitHub" is the primary CTA (header, hero, and final CTA); the email
capture (see Waitlist above) is secondary, with a quiet "Get updates" link in the
hero pointing at the form. (A `NEXT_PUBLIC_REPO_PUBLIC` dark-launch flag used to
gate this; it was removed in favor of a single GitHub-forward state.)

## Content notes

The whitespace-sensitive, pre-highlighted terminal and YAML/code blocks on the
landing sections live in `components/code-blocks.ts` — extracted verbatim from the
design source and rendered with `dangerouslySetInnerHTML` to preserve exact
whitespace and highlight spans (static, build-time, author-controlled). Edit them
there rather than re-typing markup inline. (The `/docs` code blocks are different —
those are highlighted at build by Shiki from the real markdown.)

## Deploy (Vercel)

This app lives in a pnpm monorepo. In the Vercel project:

- **Root Directory:** `apps/web`
- **Framework Preset:** Next.js (auto-detected). Install/build/output are
  auto-detected; no `vercel.json` needed (rewrites/headers live in
  `next.config.ts`).
- **Environment variables:**
  - `BUTTONDOWN_API_KEY` — from Buttondown → Settings → Programming → API.
- **Domains:** add both `bunsen.dev` and `schemas.bunsen.dev` to the project.
  `schemas.bunsen.dev` is a plain alias — the schema files live at the served
  root, so the subdomain needs no special routing.

A push to `main` deploys production.

**Smoke-test after deploy:** hero renders; `/docs/scorers` renders (highlighted
code, tables, working sidebar); a waitlist submission lands a real Buttondown
subscriber and returns the success state; and
`https://schemas.bunsen.dev/project.v1.json` resolves with
`Content-Type: application/json`.
