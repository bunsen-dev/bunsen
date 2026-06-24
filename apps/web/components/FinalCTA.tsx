import { GitHubIcon } from "@/components/icons";
import { WaitlistForm } from "@/components/WaitlistForm";
import { links } from "@/lib/site";

export function FinalCTA({ waitlistStatus }: { waitlistStatus?: string }) {
  return (
    <section className="finalcta">
      <div className="wrap">
        <h2>
          Bring any agent. Bring any task. Bunsen brings the insights{" "}
          <em>and</em> the evidence.
        </h2>
        <p>
          The CLI is source-available today — <code>curl -fsSL https://bunsen.dev/install.sh | sh</code>. Join the list for
          releases and early access to the hosted lab: remote runs, shared analysis, publishing.
        </p>
        <div className="cta-row">
          <a className="btn btn-primary" href={links.github}>
            <GitHubIcon />
            Browse the repo
          </a>
          <a className="btn btn-ghost" href="/docs">
            Read the docs →
          </a>
        </div>

        <WaitlistForm status={waitlistStatus} />

        <div className="fine">
          Source-available under PolyForm Shield 1.0.0 · Node 22+, Docker ·
          built solo by Matt Granmoe
        </div>
      </div>
    </section>
  );
}
