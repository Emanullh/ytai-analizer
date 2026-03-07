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

  it("generates orchestrator input without launching the full rerun", async () => {
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
          ok: true,
          warnings: [],
          artifactPaths: ["C:/tmp/exports/Canal_Demo/analysis/orchestrator_input.json"]
        })
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

    fireEvent.click(screen.getByRole("button", { name: "Playbook" }));
    fireEvent.click(screen.getByRole("button", { name: "Generar input JSON" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/export/generate-orchestrator-input",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" }
        })
      );
    });

    const generateCall = fetchMock.mock.calls.find(([url]) => url === "/api/export/generate-orchestrator-input");
    expect(JSON.parse(String((generateCall?.[1] as { body?: string } | undefined)?.body))).toMatchObject({
      channelName: "Canal Demo"
    });
    expect(screen.getByText("Orchestrator input generado. Ya puedes exportarlo desde el bundle.")).toBeInTheDocument();
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

  it("starts extend job from Extend tab and confirms reprocess for existing videos", async () => {
    const detailPayload = {
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
    };

    const videosPayload = [
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
    ];

    const candidatesPayload = {
      projectId: "Canal_Demo",
      projectTimeframe: "6m",
      timeframe: "6m",
      channelId: "UC123",
      channelName: "Canal Demo",
      videos: [
        {
          videoId: "video1",
          title: "Video Uno",
          publishedAt: "2026-02-20T00:00:00.000Z",
          viewCount: 1200,
          thumbnailUrl: "https://img.youtube.com/video1.jpg",
          alreadyInProject: true
        },
        {
          videoId: "video2",
          title: "Video Dos",
          publishedAt: "2026-01-20T00:00:00.000Z",
          viewCount: 900,
          thumbnailUrl: "https://img.youtube.com/video2.jpg",
          alreadyInProject: false
        }
      ]
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/Canal_Demo" && !init) {
        return {
          ok: true,
          json: async () => detailPayload
        };
      }
      if (url === "/api/projects/Canal_Demo/videos" && !init) {
        return {
          ok: true,
          json: async () => videosPayload
        };
      }
      if (url === "/api/projects/Canal_Demo/extend/candidates?timeframe=6m") {
        return {
          ok: true,
          json: async () => candidatesPayload
        };
      }
      if (url === "/api/projects/Canal_Demo/extend/jobs") {
        return {
          ok: true,
          json: async () => ({
            jobId: "job-extend-1"
          })
        };
      }
      throw new Error(`Unhandled fetch ${url}`);
    });

    class MockEventSource {
      static lastInstance: MockEventSource | null = null;
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

      constructor(public url: string) {
        MockEventSource.lastInstance = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(listener);
        this.listeners.set(type, current);
      }

      emit(type: string, data: Record<string, unknown>) {
        const current = this.listeners.get(type) ?? [];
        const event = { data: JSON.stringify(data) } as MessageEvent<string>;
        for (const listener of current) {
          listener(event);
        }
      }

      close() {}
    }

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

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

    fireEvent.click(screen.getByRole("button", { name: "Extend" }));

    await waitFor(() => {
      expect(screen.getByText("Video Dos")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Seleccionar Video Uno"));
    fireEvent.click(screen.getByLabelText("Seleccionar Video Dos"));
    fireEvent.click(screen.getByRole("button", { name: "Run Extend" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/Canal_Demo/extend/jobs",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" }
        })
      );
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const extendCall = fetchMock.mock.calls.find(([url]) => url === "/api/projects/Canal_Demo/extend/jobs");
    expect(JSON.parse(String((extendCall?.[1] as { body?: string } | undefined)?.body))).toMatchObject({
      timeframe: "6m",
      selectedVideoIds: ["video1", "video2"],
      reprocessVideoIds: ["video1"]
    });

    const eventSource = MockEventSource.lastInstance;
    expect(eventSource?.url).toBe("/api/projects/Canal_Demo/extend/jobs/job-extend-1/events");

    eventSource?.emit("job_started", {
      jobId: "job-extend-1",
      projectId: "Canal_Demo",
      total: 2
    });
    eventSource?.emit("job_progress", {
      completed: 2,
      total: 2,
      processed: 2,
      failed: 0
    });
    eventSource?.emit("job_done", {
      jobId: "job-extend-1",
      projectId: "Canal_Demo",
      addedCount: 1,
      refreshedCount: 2,
      reprocessedCount: 1
    });

    await waitFor(() => {
      expect(screen.getByText("Extend completado. El snapshot del proyecto ya fue refrescado.")).toBeInTheDocument();
    });
  });
});
