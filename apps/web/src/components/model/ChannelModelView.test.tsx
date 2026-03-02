// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChannelModelView from "./ChannelModelView";

describe("ChannelModelView", () => {
  it("renders coefficients table", () => {
    render(
      <ChannelModelView
        channelModelArtifact={{
          schemaVersion: "derived.channel_models.v1",
          computedAt: "2026-03-01T00:00:00.000Z",
          timeframe: "6m",
          model: {
            type: "robust-linear",
            formula: "log1p(views) ~ ...",
            coefficients: {
              logDaysSincePublish: -0.1,
              isShort: 0.2
            },
            fit: {
              n: 20,
              r2Approx: 0.6,
              madResidual: 0.3,
              notes: []
            }
          }
        }}
      />
    );

    expect(screen.getByText("Baseline Model")).toBeInTheDocument();
    expect(screen.getByText("logDaysSincePublish")).toBeInTheDocument();
    expect(screen.getByText("-0.1000")).toBeInTheDocument();
  });
});
