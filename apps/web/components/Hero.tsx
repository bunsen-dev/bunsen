import { RunBar } from "@/components/RunBar";
import { GitHubIcon } from "@/components/icons";
import { links, WAITLIST_ANCHOR } from "@/lib/site";

export function Hero() {
  return (
    <section className="hero">
      <div className="wrap hero-copy">
        <h1 className="display">
          An autonomous research lab for agentic systems.
        </h1>
        <p className="lede">
          <span className="triad">Any agent. Any experiment. Deep evals.</span>
          The easiest way to learn about and improve <em>any</em> agentic
          system.
        </p>
        <div className="cta-row">
          <a className="btn btn-primary" href={links.github}>
            <GitHubIcon />
            View on GitHub
          </a>
          <a className="btn btn-ghost" href="#start">
            Get started →
          </a>
        </div>
        <p className="hero-tertiary">
          Just want to follow along? <a href={WAITLIST_ANCHOR}>Get updates →</a>
        </p>
      </div>

      <div className="wrap">
        <RunBar />
      </div>
    </section>
  );
}
