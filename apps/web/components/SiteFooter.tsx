import { Brand } from "@/components/Flame";
import { links, site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="site">
      <div className="wrap foot">
        <Brand gradientId="flame-footer" />
        <div className="links">
          <a href={links.github}>GitHub</a>
          <a href={links.linkedin}>Built by Matt Granmoe</a>
        </div>
        <div className="copy">
          {site.descriptor} · © {site.year} {site.author}
        </div>
      </div>
    </footer>
  );
}
