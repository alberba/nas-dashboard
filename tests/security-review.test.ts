import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecurityReviewContent } from "../src/components/views/security-review";
import { securityReviewReason, securityReviewRows } from "../src/lib/security-review";
import type { MaintenanceReview, MaintenanceSnapshot } from "../src/lib/maintenance";
import type { SnapshotState } from "../src/lib/maintenance-polling";

const comparison: MaintenanceReview = {
  names: ["tdarr"], from: "2.58.02", to: "3.08.00", semver: "major",
  cves: 4, newSevere: 3, verifiedAt: "2026-11-14T09:20:00Z",
  reason: "major version: manual review",
};
function state(review: MaintenanceReview[] = [comparison]): SnapshotState {
  return { phase: "ready", stale: false, snapshot: {
    timestamp: 1_800_000_000,
    security: { review, pins: [], pending: null }, degraded: [],
  } as unknown as MaintenanceSnapshot };
}
const render = (value: SnapshotState) => renderToStaticMarkup(createElement(SecurityReviewContent, { state: value }));

describe("security comparison decisions", () => {
  it("keeps a major review and its CVE regression independent", () => {
    const html = render(state());
    expect(html).toContain('data-reason="major"');
    expect(html).toContain('data-cves-fixed="4"');
    expect(html).toContain('data-cves-new="3"');
    expect(html).toContain('data-review-freshness="unconfirmed"');
    expect(html).toContain('aria-pressed="true"');
  });
  it("keeps operational blockers when no new severe CVEs were detected", () => {
    const html = render(state([{ ...comparison, newSevere: 0, reason: "App data is shared with another running container" }]));
    expect(html).toContain('data-reason="shared-data"');
    expect(html).toContain('data-cves-new="0"');
  });
  it("does not turn an unavailable or partial source into a successful empty result", () => {
    const unavailable = render({ phase: "error", stale: false, snapshot: null });
    expect(unavailable).toContain('data-phase="error"');
    expect(unavailable).not.toContain('data-security-review-empty');
    const partial = state([]);
    partial.stale = true;
    partial.snapshot!.degraded = ["security"];
    const html = render(partial);
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('data-degraded="true"');
    expect(html).toContain('data-security-review-empty');
    expect(html).not.toContain('data-security-review-detail');
  });
  it("preserves distinct candidates and duplicate records, with stable keys across polling reorder", () => {
    const other = { ...comparison, to: "3.09.00" };
    const initial = securityReviewRows([comparison, other, comparison]);
    expect(new Set(initial.map((row) => row.id)).size).toBe(3);
    const reordered = securityReviewRows([other, comparison]);
    expect(reordered[0].id).toBe(initial[1].id);
    expect(reordered[1].id).toBe(initial[0].id);
  });
  it("distinguishes unrecorded reasons from unfamiliar reasons without inventing a classification", () => {
    expect(securityReviewReason(null).code).toBe("unrecorded");
    expect(securityReviewReason("new upstream condition").code).toBe("unknown");
    expect(securityReviewReason("manual: stale comparison").code).toBe("stale");
  });
});
