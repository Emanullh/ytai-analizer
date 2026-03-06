// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectDetail from "./ProjectDetail";
import ProjectsList from "./ProjectsList";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("Projects pages", () => {
  it("renders ProjectsList items from API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            projectId: "Canal_Demo",
            channelId: "UC123",
            channelName: "Canal Demo",
            exportVersion: "1.1",
            lastExportedAt: "2026-03-01T12:00:00.000Z",
            lastJobId: "job-a1",
            counts: {
              totalVideosSelected: 2,
              transcriptsOk: 1,
              transcriptsMissing: 1,
              transcriptsError: 0,
              thumbnailsOk: 2,
              thumbnailsFailed: 0
            },
            warningsCount: 0,
            status: "ok",
            warnings: []
          }
        ]
      })
    );

    render(
      <MemoryRouter>
        <ProjectsList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Canal Demo")).toBeInTheDocument();
    });
    expect(screen.getByText("Abrir proyecto")).toBeInTheDocument();
  });

  it("renders ProjectDetail video table", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          projectId: "Canal_Demo",
          channel: {
            channelId: "UC123",
            channelName: "Canal Demo",
            sourceInput: "https://www.youtube.com/@demo",
            timeframe: "6m",
            exportedAt: "2026-03-01T12:00:00.000Z",
            timeframeResolved: null
          },
          manifest: {
            counts: {
              totalVideosSelected: 1,
              transcriptsOk: 1,
              transcriptsMissing: 0,
              transcriptsError: 0,
              thumbnailsOk: 1,
              thumbnailsFailed: 0
            },
            warnings: []
          },
          latestJob: {
            jobId: "job-a1",
            status: "done",
            startedAt: "2026-03-01T11:59:00.000Z",
            finishedAt: "2026-03-01T12:00:00.000Z",
            durationMs: 60000,
            warningsCount: 0,
            errorsCount: 0
          },
          jobs: [],
          artifacts: {
            playbook: null,
            templates: null,
            channelModels: null
          },
          warnings: []
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            videoId: "video1",
            title: "Video Uno",
            publishedAt: "2026-02-20T00:00:00.000Z",
            thumbnailPath: "thumbnails/video1.jpg",
            transcriptStatus: "ok",
            transcriptSource: "captions",
            performance: {
              viewsPerDay: 12,
              engagementRate: 0.1,
              residual: 0.2,
              percentile: 70
            },
            hasLLM: {
              description: true,
              transcript: false,
              thumbnail: true
            },
            cacheHit: "full"
          }
        ]
      });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/Canal_Demo"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getAllByText("Video Uno").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Videos (1)")).toBeInTheDocument();
  });

  it("sends redownloadMissingThumbnails in thumbnail rerun payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          projectId: "Canal_Demo",
          channel: {
            channelId: "UC123",
            channelName: "Canal Demo",
            sourceInput: "https://www.youtube.com/@demo",
            timeframe: "6m",
            exportedAt: "2026-03-01T12:00:00.000Z",
            timeframeResolved: null
          },
          manifest: {
            counts: {
              totalVideosSelected: 1,
              transcriptsOk: 1,
              transcriptsMissing: 0,
              transcriptsError: 0,
              thumbnailsOk: 1,
              thumbnailsFailed: 0
            },
            warnings: []
          },
          latestJob: {
            jobId: "job-a1",
            status: "done",
            startedAt: "2026-03-01T11:59:00.000Z",
            finishedAt: "2026-03-01T12:00:00.000Z",
            durationMs: 60000,
            warningsCount: 0,
            errorsCount: 0
          },
          jobs: [],
          artifacts: {
            playbook: null,
            templates: null,
            channelModels: null
          },
          warnings: []
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            videoId: "video1",
            title: "Video Uno",
            publishedAt: "2026-02-20T00:00:00.000Z",
            thumbnailPath: "thumbnails/video1.jpg",
            transcriptStatus: "ok",
            transcriptSource: "captions",
            performance: {
              viewsPerDay: 12,
              engagementRate: 0.1,
              residual: 0.2,
              percentile: 70
            },
            hasLLM: {
              description: true,
              transcript: false,
              thumbnail: true
            },
            cacheHit: "full"
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobId: "job-rerun-1"
        })
      });

    class MockEventSource {
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      constructor(public url: string) {}
      addEventListener() {}
      close() {}
    }

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    render(
      <MemoryRouter initialEntries={["/projects/Canal_Demo"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getAllByText("Video Uno").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Recompute thumbnails" }));
    fireEvent.click(screen.getByLabelText("Re-descargar thumbnails faltantes antes de correr OCR"));
    fireEvent.click(screen.getByRole("button", { name: "Start rerun" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const rerunCall = fetchMock.mock.calls[2];
    expect(rerunCall?.[0]).toBe("/api/projects/Canal_Demo/rerun/thumbnails");
    expect(rerunCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    expect(JSON.parse(String((rerunCall?.[1] as { body?: string } | undefined)?.body))).toMatchObject({
      scope: "all",
      engine: "python",
      force: false,
      redownloadMissingThumbnails: true
    });
  });
});
