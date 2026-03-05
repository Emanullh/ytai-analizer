// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PlaybookView from "./PlaybookView";

describe("PlaybookView", () => {
  it("renders insights table and shows tooltips on interaction", () => {
    const onEvidenceClick = vi.fn();

    render(
      <PlaybookView
        playbook={{
          schemaVersion: "analysis.playbook.v1",
          channel: {
            channelName: "Canal Demo",
            timeframe: "6m",
            jobId: "job-1"
          },
          generatedAt: "2026-03-01T00:00:00.000Z",
          insights: [
            {
              title: "Insight A",
              summary: "Summary A",
              confidence: 0.85,
              supported_by: ["video-1"],
              evidence_fields: ["performance.residual"]
            }
          ],
          rules: [],
          keys: [],
          evidence: {
            cohorts: [],
            drivers: [],
            exemplars: {}
          }
        }}
        onEvidenceFieldClick={onEvidenceClick}
      />
    );

    expect(screen.getByText("Insights")).toBeInTheDocument();
    expect(screen.getByText("Insight A")).toBeInTheDocument();
    expect(screen.getByText("performance.residual")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(screen.getByText("Confidence"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("0..1, basado en fuerza de evidencia");
  });
});
