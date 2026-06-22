/**
 * The Bunsen burner flame mark used in the header and footer wordmark. The
 * gradient needs a document-unique id, so callers pass one (a single SVG
 * gradient id reused twice on a page would collide).
 */
export function Flame({ gradientId }: { gradientId: string }) {
  return (
    <svg className="flame" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2c1.4 3.2-1.8 4.6-1.8 7.6 0 1.2.7 2.1 1.6 2.5.2-.9-.1-1.9.5-2.7.7 1.5 2.4 2.2 2.4 4.6A4.7 4.7 0 0 1 12 19a4.7 4.7 0 0 1-2.7-8.6C8.4 6.6 11.3 5.4 12 2Z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="12"
          y1="2"
          x2="12"
          y2="19"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fbbf24" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Flame + "Bunsen" wordmark. Links to `/#top`: scrolls to the top on the home
 * page (which has `<main id="top">`) and navigates home from anywhere else.
 */
export function Brand({
  gradientId,
  ariaLabel,
}: {
  gradientId: string;
  ariaLabel?: string;
}) {
  return (
    <a className="brand" href="/#top" aria-label={ariaLabel}>
      <Flame gradientId={gradientId} />
      Bunsen
    </a>
  );
}
