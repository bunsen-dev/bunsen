/**
 * The Bunsen burner mark + "Bunsen" wordmark, used in the site header and
 * footer. Links to `/#top`: scrolls to the top on the home page (which has
 * `<main id="top">`) and navigates home from anywhere else.
 *
 * The mark is the traced burner logo (`public/bunsen-logo.svg`), rendered as an
 * `<img>` so its path data is fetched once and cached rather than inlined into
 * every page's HTML twice over. `alt=""` because the adjacent "Bunsen" wordmark
 * (and the header's `aria-label`) already name the link; `width`/`height` carry
 * the intrinsic aspect ratio so the row doesn't reflow once the SVG loads.
 */
export function Brand({ ariaLabel }: { ariaLabel?: string }) {
  return (
    <a className="brand" href="/#top" aria-label={ariaLabel}>
      <img
        className="brand-mark"
        src="/bunsen-logo.svg"
        alt=""
        width={409}
        height={1065}
      />
      Bunsen
    </a>
  );
}
