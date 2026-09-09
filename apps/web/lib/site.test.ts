import { describe, it, expect } from "vitest";
import { links, REPO_SLUG, site } from "./site";

describe("site config", () => {
  it("points at the canonical bunsen-dev/bunsen repo", () => {
    expect(REPO_SLUG).toBe("bunsen-dev/bunsen");
    expect(links.github).toBe("https://github.com/bunsen-dev/bunsen");
  });

  it("uses only absolute https or mailto links", () => {
    for (const url of Object.values(links)) {
      expect(url).toMatch(/^(https:\/\/|mailto:)/);
    }
  });

  it("markets Bunsen as open source under Apache-2.0", () => {
    expect(site.licenseLine).toContain("Apache-2.0");
    expect(site.licenseLine).toContain("Open source");
    for (const value of Object.values(site)) {
      if (typeof value === "string") {
        expect(value).not.toMatch(/source[ -]available|poly[f]orm/i);
      }
    }
  });
});
