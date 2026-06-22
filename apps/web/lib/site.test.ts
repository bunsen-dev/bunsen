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

  it("never markets Bunsen as 'open source' (it is source-available)", () => {
    for (const value of Object.values(site)) {
      if (typeof value === "string") {
        expect(value.toLowerCase()).not.toContain("open source");
      }
    }
  });
});
