export const REPO_SLUG = "bunsen-dev/bunsen";

export const links = {
  github: `https://github.com/${REPO_SLUG}`,
  linkedin: "https://www.linkedin.com/in/mattgranmoe/",
} as const;

/**
 * Link to the waitlist / updates capture (the final CTA lives on the home page).
 * Absolute (`/#…`) so it also works from /docs/* — bare `#waitlist` only resolves
 * on a page that contains the anchor.
 */
export const WAITLIST_ANCHOR = "/#waitlist";

export const site = {
  name: "Bunsen",
  descriptor: "An autonomous research lab for agentic systems",
  year: 2026,
  author: "Matthew Job Granmoe",
} as const;
