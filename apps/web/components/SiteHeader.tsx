import { Brand } from "@/components/Flame";
import { GitHubIcon } from "@/components/icons";
import { links } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="site">
      <div className="wrap nav">
        <Brand gradientId="flame-header" ariaLabel="Bunsen home" />
        <nav className="nav-links">
          <a className="navlink" href="/#anything">
            Eval anything
          </a>
          <a className="navlink" href="/#start">
            Get started
          </a>
          <a className="navlink" href="/#deep">
            Deep evals
          </a>
          <a className="navlink" href="/docs">
            Docs
          </a>
          <a className="nav-cta" href={links.github}>
            <GitHubIcon />
            View on GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
