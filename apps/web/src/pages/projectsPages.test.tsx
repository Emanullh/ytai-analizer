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
              title: true,
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
    expect(screen.getAllByText("Pendiente orchestrator").length).toBeGreaterThan(0);
    expect(screen.getByText("Captions (legacy)")).toBeInTheDocument();
  });

  it("starts thumbnail batch rerun from the unified feature dropdown", async () => {
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
              title: true,
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
    fireEvent.click(await screen.findByRole("button", { name: "Batch rerun feature" }));
    fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "thumbnail" } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "collect_assets" } });
    fireEvent.click(screen.getByRole("button", { name: "Start step" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const rerunCall = fetchMock.mock.calls[2];
    expect(rerunCall?.[0]).toBe("/api/projects/Canal_Demo/rerun/features");
    expect(rerunCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    expect(JSON.parse(String((rerunCall?.[1] as { body?: string } | undefined)?.body))).toMatchObject({
      feature: "thumbnail",
      mode: "collect_assets",
      scope: "all",
    });
  });

  it("renders feature analysis cards and reruns a single feature from video detail", async () => {
    const detailPayload = {
      videoId: "video1",
      derived: {
        thumbnailFeatures: {
          deterministic: {
            ocrText: "TEXTO",
            ocrWordCountHiConf: 3,
            textAreaRatio: 0.22,
            hasBigText: true
          },
          llm: {
            archetype: { label: "text-heavy" },
            clutterLevel: { label: "medium" },
            styleTags: [{ label: "big-text" }, { label: "colorful" }]
          },
          warnings: []
        },
        titleFeatures: {
          deterministic: {
            title_len_words: 4,
            caps_ratio: 0.4,
            has_number: true,
            title_keyword_coverage: 0.5,
            title_keyword_early_coverage_30s: 0.25
          },
          llm: {
            promise_type: [{ label: "howto/tutorial" }],
            curiosity_gap_type: [{ label: "warning" }],
            headline_claim_strength: { label: "high" }
          }
        },
        descriptionFeatures: {
          deterministic: {
            desc_len_words: 30,
            url_count: 2,
            domain_counts: [{ domain: "youtube.com" }],
            has_sponsor_disclosure: true,
            has_affiliate_disclosure: false
          },
          llm: {
            primaryCTA: { label: "subscribe" },
            sponsorBrandMentions: [{ brand: "MarcaX" }],
            linkPurpose: [{ label: "social" }]
          },
          warnings: []
        },
        transcriptFeatures: {
          deterministic: {
            title_keyword_coverage: 0.4,
            promise_delivery_30s_score: 0.62,
            wpm_overall: 155,
            topic_shift_count: 2
          },
          llm: {
            story_arc: { label: "tutorial" },
            cta_segments: [{ type: "subscribe" }],
            sponsor_segments: [{ brand: "MarcaX" }]
          },
          warnings: []
        }
      },
      transcriptJsonl: [
        { type: "segment", text: "hola mundo" },
        { type: "segment", text: "cta subscribe" }
      ],
      rawVideo: {
        videoId: "video1",
        title: "Video Uno",
        publishedAt: "2026-02-20T00:00:00.000Z",
        durationSec: 180,
        defaultLanguage: "es",
        description: "Descripcion de prueba"
      }
    };

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
          latestJob: null,
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
              title: true,
              description: true,
              transcript: true,
              thumbnail: true
            },
            cacheHit: "full"
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => detailPayload
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          feature: "title",
          warnings: ["AutoGen skipped"]
        })
      })
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
          latestJob: null,
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
              title: false,
              description: true,
              transcript: true,
              thumbnail: true
            },
            cacheHit: "full"
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => detailPayload
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

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(await screen.findByText("Thumbnail")).toBeInTheDocument();
    expect(screen.getByText("Promise type")).toBeInTheDocument();
    expect(screen.getByText("Story arc")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prestep title" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(7);
    });

    const rerunCall = fetchMock.mock.calls[3];
    expect(rerunCall?.[0]).toBe("/api/projects/Canal_Demo/videos/video1/rerun/title");
    expect(rerunCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    expect(JSON.parse(String((rerunCall?.[1] as { body?: string } | undefined)?.body))).toMatchObject({
      mode: "prepare"
    });
  });

  it("starts project-level batch rerun for a selected feature", async () => {
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
              title: true,
              description: true,
              transcript: true,
              thumbnail: true
            },
            cacheHit: "full"
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobId: "job-feature-1"
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
    fireEvent.click(await screen.findByRole("button", { name: "Batch rerun feature" }));
    fireEvent.click(screen.getByRole("button", { name: "Start step" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const rerunCall = fetchMock.mock.calls[2];
    expect(rerunCall?.[0]).toBe("/api/projects/Canal_Demo/rerun/features");
    expect(rerunCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    expect(JSON.parse(String((rerunCall?.[1] as { body?: string } | undefined)?.body))).toMatchObject({
      feature: "title",
      mode: "full",
      scope: "all"
    });
  });
});
