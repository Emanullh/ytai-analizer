import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Badge from "../components/Badge";
import Collapsible from "../components/Collapsible";
import Section from "../components/Section";
import StatCard from "../components/StatCard";
import Tooltip from "../components/Tooltip";
import PlaybookView from "../components/playbook/PlaybookView";
import TemplatesView from "../components/templates/TemplatesView";
import ChannelModelView from "../components/model/ChannelModelView";
import PercentileDistributionChart from "../components/charts/PercentileDistributionChart";
import SectionExplainer from "../components/SectionExplainer";
import { asRecord, asString, valueToText } from "../lib/artifactUtils";
import { getByPath } from "../lib/getByPath";
import { ProjectDetailResponse, ProjectVideoDetail, ProjectVideoSummary } from "../types";

type ArtifactTab = "overview" | "playbook" | "templates" | "model" | "jobs";
type ThumbnailRerunScope = "all" | "exemplars" | "selected";
type ThumbnailRerunEngine = "python" | "auto";

type ArtifactState = {
  data: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
  loaded: boolean;
};

interface EvidencePanelState {
  open: boolean;
  fieldPath: string;
  supportedBy: string[];
}

interface ThumbnailRerunModalState {
  open: boolean;
  scope: ThumbnailRerunScope;
  selectedVideoIdsInput: string;
  engine: ThumbnailRerunEngine;
  force: boolean;
  redownloadMissingThumbnails: boolean;
  running: boolean;
  jobId: string | null;
  total: number;
  completed: number;
  processed: number;
  skipped: number;
  failed: number;
  warnings: string[];
  videoErrors: Array<{ videoId: string; message: string }>;
  error: string | null;
  done: boolean;
  auditArtifactPath: string | null;
}

const INITIAL_ARTIFACT_STATE: ArtifactState = {
  data: null,
  loading: false,
  error: null,
  loaded: false
};

function createInitialThumbnailRerunState(): ThumbnailRerunModalState {
  return {
    open: false,
    scope: "all",
    selectedVideoIdsInput: "",
    engine: "python",
    force: false,
    redownloadMissingThumbnails: false,
    running: false,
    jobId: null,
    total: 0,
    completed: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
    videoErrors: [],
    error: null,
    done: false,
    auditArtifactPath: null
  };
}

function parseVideoIdsInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\\n]/g)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("es-ES");
}

function formatDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return "-";
  }
  const sec = Math.round(durationMs / 1000);
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return `${min}m ${remain}s`;
}

function formatMetric(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(digits);
}

function formatPercentile(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.max(0, Math.min(100, normalized)).toFixed(1)}%`;
}

function transcriptVariant(status: "ok" | "missing" | "error"): "success" | "warning" | "danger" {
  if (status === "ok") {
    return "success";
  }
  if (status === "missing") {
    return "warning";
  }
  return "danger";
}

function cacheVariant(cacheHit: ProjectVideoSummary["cacheHit"]): "success" | "info" | "neutral" {
  if (cacheHit === "full") {
    return "success";
  }
  if (cacheHit === "partial") {
    return "info";
  }
  return "neutral";
}

function percentileVariant(value: number | null | undefined): "success" | "warning" | "neutral" {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "neutral";
  }
  const normalized = value <= 1 ? value * 100 : value;
  if (normalized >= 75) {
    return "success";
  }
  if (normalized >= 45) {
    return "warning";
  }
  return "neutral";
}

function residualVariant(value: number | null | undefined): "success" | "danger" | "neutral" {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "neutral";
  }
  if (value > 0.05) {
    return "success";
  }
  if (value < -0.05) {
    return "danger";
  }
  return "neutral";
}

function tabClass(active: boolean): string {
  return active
    ? "rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
    : "rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200";
}

function JsonBlock({ value }: { value: unknown }) {
  if (value == null) {
    return <p className="text-sm text-slate-500">No disponible.</p>;
  }
  return (
    <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ArtifactEmptyState({ label }: { label: string }) {
  return (
    <section className="panel p-5">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-sm text-slate-600">
          i
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-900">{label} no disponible</p>
          <p className="mt-1 text-sm text-slate-600">No se encontró artifact exportado para este proyecto.</p>
          <Link to="/" className="btn-ghost mt-3 !rounded-lg !px-3 !py-1.5 !text-xs">
            Ir a Analyze para re-export
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function ProjectDetail() {
  const { projectId: projectIdParam } = useParams<{ projectId: string }>();
  const projectId = projectIdParam ? decodeURIComponent(projectIdParam) : "";

  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [videos, setVideos] = useState<ProjectVideoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ArtifactTab>("overview");
  const [playbookState, setPlaybookState] = useState<ArtifactState>(INITIAL_ARTIFACT_STATE);
  const [templatesState, setTemplatesState] = useState<ArtifactState>(INITIAL_ARTIFACT_STATE);
  const [channelModelState, setChannelModelState] = useState<ArtifactState>(INITIAL_ARTIFACT_STATE);

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedVideoDetail, setSelectedVideoDetail] = useState<ProjectVideoDetail | null>(null);
  const [videoDetailLoading, setVideoDetailLoading] = useState(false);
  const [videoDetailError, setVideoDetailError] = useState<string | null>(null);
  const [transcriptSearch, setTranscriptSearch] = useState("");

  const [videoDetailCache, setVideoDetailCache] = useState<Record<string, ProjectVideoDetail>>({});
  const videoDetailInFlightRef = useRef(new Map<string, Promise<ProjectVideoDetail>>());
  const [thumbnailLoadingIds, setThumbnailLoadingIds] = useState<string[]>([]);

  const [evidencePanel, setEvidencePanel] = useState<EvidencePanelState>({
    open: false,
    fieldPath: "",
    supportedBy: []
  });
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const [rerunState, setRerunState] = useState<{
    running: boolean;
    error: string | null;
    checks: Array<{ artifact: string; exists: boolean; detail?: string }> | null;
    result: { ok: boolean; warnings: string[]; usedLlm: boolean } | null;
  }>({ running: false, error: null, checks: null, result: null });

  const thumbnailRerunEventSourceRef = useRef<EventSource | null>(null);
  const [thumbnailRerunState, setThumbnailRerunState] = useState<ThumbnailRerunModalState>(
    createInitialThumbnailRerunState()
  );

  useEffect(() => {
    if (!projectId) {
      return;
    }

    let canceled = false;

    const fetchJson = async <T,>(url: string): Promise<T> => {
      const response = await fetch(url);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Error al cargar ${url}`);
      }
      return (await response.json()) as T;
    };

    const run = async () => {
      setLoading(true);
      setError(null);
      setSelectedVideoId(null);
      setSelectedVideoDetail(null);
      setVideoDetailCache({});
      setEvidencePanel({ open: false, fieldPath: "", supportedBy: [] });
      setPlaybookState(INITIAL_ARTIFACT_STATE);
      setTemplatesState(INITIAL_ARTIFACT_STATE);
      setChannelModelState(INITIAL_ARTIFACT_STATE);
      setActiveTab("overview");

      try {
        const encodedId = encodeURIComponent(projectId);
        const [projectDetail, projectVideos] = await Promise.all([
          fetchJson<ProjectDetailResponse>(`/api/projects/${encodedId}`),
          fetchJson<ProjectVideoSummary[]>(`/api/projects/${encodedId}/videos`)
        ]);

        if (!canceled) {
          setDetail(projectDetail);
          setVideos(projectVideos);
        }
      } catch (requestError) {
        if (!canceled) {
          setError(requestError instanceof Error ? requestError.message : "Error inesperado.");
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      canceled = true;
    };
  }, [projectId]);

  const loadArtifact = useCallback(
    async (kind: "playbook" | "templates" | "channelModels") => {
      if (!projectId || !detail) {
        return;
      }

      const encodedId = encodeURIComponent(projectId);
      const target =
        kind === "playbook"
          ? {
              state: playbookState,
              setState: setPlaybookState,
              path: detail.artifacts.playbook,
              endpoint: `/api/projects/${encodedId}/artifacts/playbook`
            }
          : kind === "templates"
            ? {
                state: templatesState,
                setState: setTemplatesState,
                path: detail.artifacts.templates,
                endpoint: `/api/projects/${encodedId}/artifacts/templates`
              }
            : {
                state: channelModelState,
                setState: setChannelModelState,
                path: detail.artifacts.channelModels,
                endpoint: `/api/projects/${encodedId}/artifacts/channel_models`
              };

      if (target.state.loaded || target.state.loading) {
        return;
      }

      if (!target.path) {
        target.setState({ data: null, loading: false, error: null, loaded: true });
        return;
      }

      target.setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const response = await fetch(target.endpoint);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `No fue posible cargar ${kind}`);
        }
        const payload = (await response.json()) as Record<string, unknown>;
        target.setState({ data: payload, loading: false, error: null, loaded: true });
      } catch (requestError) {
        target.setState({
          data: null,
          loading: false,
          error: requestError instanceof Error ? requestError.message : "Error inesperado.",
          loaded: true
        });
      }
    },
    [projectId, detail, playbookState, templatesState, channelModelState]
  );

  useEffect(() => {
    if (activeTab === "playbook") {
      void loadArtifact("playbook");
    }
    if (activeTab === "templates") {
      void loadArtifact("templates");
    }
    if (activeTab === "model") {
      void loadArtifact("channelModels");
    }
  }, [activeTab, loadArtifact]);

  const loadVideoDetail = useCallback(
    async (videoId: string, options?: { maxSegments?: number }): Promise<ProjectVideoDetail> => {
      const cached = videoDetailCache[videoId];
      if (cached) {
        return cached;
      }

      const inFlight = videoDetailInFlightRef.current.get(videoId);
      if (inFlight) {
        return inFlight;
      }

      if (!projectId) {
        throw new Error("Project inválido");
      }

      const maxSegments = options?.maxSegments ?? 200;

      const request = fetch(
        `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}?maxSegments=${maxSegments}`
      )
        .then(async (response) => {
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(payload?.error ?? "No fue posible cargar detalles del video.");
          }
          return (await response.json()) as ProjectVideoDetail;
        })
        .then((payload) => {
          setVideoDetailCache((prev) => ({ ...prev, [videoId]: payload }));
          return payload;
        })
        .finally(() => {
          videoDetailInFlightRef.current.delete(videoId);
        });

      videoDetailInFlightRef.current.set(videoId, request);
      return request;
    },
    [projectId, videoDetailCache]
  );

  const openVideoDetail = async (videoId: string) => {
    setSelectedVideoId(videoId);
    setVideoDetailLoading(true);
    setVideoDetailError(null);
    setTranscriptSearch("");

    try {
      const payload = await loadVideoDetail(videoId, { maxSegments: 200 });
      setSelectedVideoDetail(payload);
    } catch (requestError) {
      setVideoDetailError(requestError instanceof Error ? requestError.message : "Error inesperado.");
      setSelectedVideoDetail(null);
    } finally {
      setVideoDetailLoading(false);
    }
  };

  const prefetchVideoDetailForThumbnail = useCallback(
    async (videoId: string) => {
      if (videoDetailCache[videoId] || thumbnailLoadingIds.includes(videoId)) {
        return;
      }
      setThumbnailLoadingIds((prev) => [...prev, videoId]);
      try {
        await loadVideoDetail(videoId, { maxSegments: 1 });
      } catch {
        // silent prefetch failure
      } finally {
        setThumbnailLoadingIds((prev) => prev.filter((id) => id !== videoId));
      }
    },
    [loadVideoDetail, thumbnailLoadingIds, videoDetailCache]
  );

  const closeVideoDetail = () => {
    setSelectedVideoId(null);
    setSelectedVideoDetail(null);
    setVideoDetailError(null);
    setTranscriptSearch("");
  };

  const openEvidenceField = useCallback((fieldPath: string, supportedBy: string[]) => {
    setEvidencePanel({
      open: true,
      fieldPath,
      supportedBy: Array.from(new Set(supportedBy))
    });
  }, []);

  const handleRerunOrchestrator = useCallback(async () => {
    const channelName = detail?.channel.channelName;
    if (!channelName) return;

    setRerunState({ running: true, error: null, checks: null, result: null });

    try {
      const response = await fetch("/api/export/rerun-orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelName })
      });

      const payload = await response.json() as Record<string, unknown>;

      if (response.status === 409) {
        const checks = Array.isArray(payload.checks)
          ? (payload.checks as Array<{ artifact: string; exists: boolean; detail?: string }>)
          : null;
        setRerunState({
          running: false,
          error: (payload.error as string) ?? "Prerequisitos faltantes",
          checks,
          result: null
        });
        return;
      }

      if (!response.ok) {
        setRerunState({
          running: false,
          error: (payload.error as string) ?? `Error ${response.status}`,
          checks: null,
          result: null
        });
        return;
      }

      setRerunState({
        running: false,
        error: null,
        checks: null,
        result: {
          ok: true,
          warnings: Array.isArray(payload.warnings) ? (payload.warnings as string[]) : [],
          usedLlm: payload.usedLlm === true
        }
      });

      setPlaybookState(INITIAL_ARTIFACT_STATE);
      setTemplatesState(INITIAL_ARTIFACT_STATE);
      void loadArtifact("playbook");
      void loadArtifact("templates");
    } catch (requestError) {
      setRerunState({
        running: false,
        error: requestError instanceof Error ? requestError.message : "Error inesperado",
        checks: null,
        result: null
      });
    }
  }, [detail, loadArtifact]);

  const refreshVideosAfterThumbnailRerun = useCallback(async () => {
    if (!projectId) {
      return;
    }
    try {
      const encodedId = encodeURIComponent(projectId);
      const [detailResponse, videosResponse] = await Promise.all([
        fetch(`/api/projects/${encodedId}`),
        fetch(`/api/projects/${encodedId}/videos`)
      ]);
      if (!detailResponse.ok || !videosResponse.ok) {
        return;
      }
      const [detailPayload, videosPayload] = (await Promise.all([
        detailResponse.json(),
        videosResponse.json()
      ])) as [ProjectDetailResponse, ProjectVideoSummary[]];
      setDetail(detailPayload);
      setVideos(videosPayload);
      setVideoDetailCache({});
      setSelectedVideoDetail(null);
      setSelectedVideoId(null);
      setPlaybookState(INITIAL_ARTIFACT_STATE);
      setTemplatesState(INITIAL_ARTIFACT_STATE);
      setChannelModelState(INITIAL_ARTIFACT_STATE);
    } catch {
      // silent refresh failure
    }
  }, [projectId]);

  const closeThumbnailRerunModal = useCallback(() => {
    if (thumbnailRerunState.running) {
      return;
    }
    setThumbnailRerunState((prev) => ({ ...prev, open: false }));
  }, [thumbnailRerunState.running]);

  const handleRecomputeThumbnails = useCallback(async () => {
    if (!projectId) {
      return;
    }

    const selectedVideoIds =
      thumbnailRerunState.scope === "selected" ? parseVideoIdsInput(thumbnailRerunState.selectedVideoIdsInput) : undefined;
    if (thumbnailRerunState.scope === "selected" && (!selectedVideoIds || selectedVideoIds.length === 0)) {
      setThumbnailRerunState((prev) => ({
        ...prev,
        error: "Debes ingresar al menos un videoId para scope=selected."
      }));
      return;
    }

    setThumbnailRerunState((prev) => ({
      ...prev,
      running: true,
      done: false,
      error: null,
      warnings: [],
      videoErrors: [],
      total: 0,
      completed: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      jobId: null,
      auditArtifactPath: null
    }));

    try {
      const encodedId = encodeURIComponent(projectId);
      const response = await fetch(`/api/projects/${encodedId}/rerun/thumbnails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: thumbnailRerunState.scope,
          videoIds: selectedVideoIds,
          engine: thumbnailRerunState.engine,
          force: thumbnailRerunState.force,
          redownloadMissingThumbnails: thumbnailRerunState.redownloadMissingThumbnails
        })
      });

      const payload = (await response.json().catch(() => null)) as { jobId?: string; error?: string } | null;
      if (!response.ok || !payload?.jobId) {
        setThumbnailRerunState((prev) => ({
          ...prev,
          running: false,
          error: payload?.error ?? `No fue posible iniciar rerun (${response.status}).`
        }));
        return;
      }

      const { jobId } = payload;
      setThumbnailRerunState((prev) => ({
        ...prev,
        jobId
      }));

      thumbnailRerunEventSourceRef.current?.close();
      const eventSource = new EventSource(`/api/projects/${encodedId}/rerun/thumbnails/jobs/${jobId}/events`);
      thumbnailRerunEventSourceRef.current = eventSource;
      let closedByTerminalEvent = false;

      const registerEvent = (name: string, handler: (data: Record<string, unknown>) => void) => {
        eventSource.addEventListener(name, (event) => {
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
            handler(data);
          } catch {
            setThumbnailRerunState((prev) => ({
              ...prev,
              running: false,
              error: "No se pudo parsear un evento de progreso."
            }));
          }
        });
      };

      registerEvent("job_started", (data) => {
        setThumbnailRerunState((prev) => ({
          ...prev,
          total: typeof data.total === "number" ? data.total : prev.total
        }));
      });

      registerEvent("warning", (data) => {
        const message = typeof data.message === "string" ? data.message : "Warning desconocido";
        const videoId = typeof data.videoId === "string" ? data.videoId : null;
        setThumbnailRerunState((prev) => ({
          ...prev,
          warnings: [...prev.warnings, videoId ? `${videoId}: ${message}` : message]
        }));
      });

      registerEvent("video_progress", (data) => {
        const status = typeof data.status === "string" ? data.status : "";
        if (status === "failed") {
          const videoId = typeof data.videoId === "string" ? data.videoId : "unknown";
          const message = typeof data.message === "string" ? data.message : "Error desconocido";
          setThumbnailRerunState((prev) => ({
            ...prev,
            videoErrors: [...prev.videoErrors, { videoId, message }]
          }));
        }
      });

      registerEvent("job_progress", (data) => {
        setThumbnailRerunState((prev) => ({
          ...prev,
          completed: typeof data.completed === "number" ? data.completed : prev.completed,
          total: typeof data.total === "number" ? data.total : prev.total,
          processed: typeof data.processed === "number" ? data.processed : prev.processed,
          skipped: typeof data.skipped === "number" ? data.skipped : prev.skipped,
          failed: typeof data.failed === "number" ? data.failed : prev.failed
        }));
      });

      registerEvent("job_done", (data) => {
        closedByTerminalEvent = true;
        eventSource.close();
        if (thumbnailRerunEventSourceRef.current === eventSource) {
          thumbnailRerunEventSourceRef.current = null;
        }

        setThumbnailRerunState((prev) => ({
          ...prev,
          running: false,
          done: true,
          completed: typeof data.completed === "number" ? data.completed : prev.completed,
          total: typeof data.total === "number" ? data.total : prev.total,
          processed: typeof data.processed === "number" ? data.processed : prev.processed,
          skipped: typeof data.skipped === "number" ? data.skipped : prev.skipped,
          failed: typeof data.failed === "number" ? data.failed : prev.failed,
          auditArtifactPath: typeof data.auditArtifactPath === "string" ? data.auditArtifactPath : null
        }));
        void refreshVideosAfterThumbnailRerun();
      });

      registerEvent("job_failed", (data) => {
        closedByTerminalEvent = true;
        eventSource.close();
        if (thumbnailRerunEventSourceRef.current === eventSource) {
          thumbnailRerunEventSourceRef.current = null;
        }
        setThumbnailRerunState((prev) => ({
          ...prev,
          running: false,
          done: false,
          error: typeof data.message === "string" ? data.message : "Rerun falló."
        }));
      });

      eventSource.onerror = () => {
        if (closedByTerminalEvent) {
          return;
        }
        eventSource.close();
        if (thumbnailRerunEventSourceRef.current === eventSource) {
          thumbnailRerunEventSourceRef.current = null;
        }
        setThumbnailRerunState((prev) => ({
          ...prev,
          running: false,
          error: "Se perdió la conexión de progreso del rerun."
        }));
      };
    } catch (requestError) {
      setThumbnailRerunState((prev) => ({
        ...prev,
        running: false,
        error: requestError instanceof Error ? requestError.message : "Error inesperado."
      }));
    }
  }, [projectId, thumbnailRerunState, refreshVideosAfterThumbnailRerun]);

  useEffect(() => {
    if (!evidencePanel.open || evidencePanel.supportedBy.length === 0) {
      return;
    }

    let canceled = false;
    const run = async () => {
      setEvidenceLoading(true);
      setEvidenceError(null);
      try {
        await Promise.all(evidencePanel.supportedBy.map((videoId) => loadVideoDetail(videoId, { maxSegments: 1 })));
      } catch (requestError) {
        if (!canceled) {
          setEvidenceError(requestError instanceof Error ? requestError.message : "Error inesperado cargando evidencia.");
        }
      } finally {
        if (!canceled) {
          setEvidenceLoading(false);
        }
      }
    };

    void run();
    return () => {
      canceled = true;
    };
  }, [evidencePanel, loadVideoDetail]);

  useEffect(() => {
    return () => {
      thumbnailRerunEventSourceRef.current?.close();
      thumbnailRerunEventSourceRef.current = null;
    };
  }, []);

  const allWarnings = useMemo(() => {
    const fromManifest = Array.isArray(detail?.manifest?.warnings)
      ? (detail?.manifest?.warnings.filter((item): item is string => typeof item === "string") ?? [])
      : [];
    const merged = [...(detail?.warnings ?? []), ...fromManifest];
    return Array.from(new Set(merged));
  }, [detail]);

  const topVideos = useMemo(() => {
    return videos
      .slice()
      .sort((a, b) => {
        const aPct = a.performance?.percentile ?? -1;
        const bPct = b.performance?.percentile ?? -1;
        return bPct - aPct;
      })
      .slice(0, 8);
  }, [videos]);

  const transcriptRows = useMemo(() => {
    if (!selectedVideoDetail?.transcriptJsonl) {
      return [];
    }
    return selectedVideoDetail.transcriptJsonl.filter((item) => {
      if (!transcriptSearch.trim()) {
        return true;
      }
      const text = typeof item.text === "string" ? item.text : JSON.stringify(item);
      return text.toLowerCase().includes(transcriptSearch.toLowerCase());
    });
  }, [selectedVideoDetail, transcriptSearch]);

  const evidenceRows = useMemo(() => {
    if (!evidencePanel.open || !evidencePanel.fieldPath) {
      return [];
    }
    return evidencePanel.supportedBy.map((videoId) => {
      const detailData = videoDetailCache[videoId];
      const merged = detailData ? { ...(asRecord(detailData.derived) ?? {}), rawVideo: detailData.rawVideo } : null;
      const value = merged ? getByPath(merged, evidencePanel.fieldPath) : undefined;
      return {
        videoId,
        value: valueToText(value)
      };
    });
  }, [evidencePanel, videoDetailCache]);

  const debugRawJson = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ?? false;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Project</p>
            <h1 className="text-2xl font-semibold text-slate-900">{detail?.channel.channelName ?? projectId}</h1>
            <p className="mt-1 text-xs text-slate-500">{projectId}</p>
          </div>
          <Link to="/projects" className="btn-ghost !rounded-lg !px-3 !py-2 !text-xs">
            Volver a Projects
          </Link>
        </div>

        {loading ? <p className="mt-4 text-sm text-slate-600">Cargando proyecto...</p> : null}
        {error ? <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

        {detail ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard
              label="Videos seleccionados"
              value={detail.manifest?.counts?.totalVideosSelected ?? 0}
              hint="Total de videos incluidos en el export actual"
            />
            <StatCard label="Transcripts OK" value={detail.manifest?.counts?.transcriptsOk ?? 0} hint="Transcripts obtenidos sin error" />
            <StatCard
              label="Transcripts Missing/Error"
              value={(detail.manifest?.counts?.transcriptsMissing ?? 0) + (detail.manifest?.counts?.transcriptsError ?? 0)}
              hint="Transcripts faltantes o fallidos"
            />
            <StatCard
              label="Thumbnails OK/Failed"
              value={`${detail.manifest?.counts?.thumbnailsOk ?? 0}/${detail.manifest?.counts?.thumbnailsFailed ?? 0}`}
              hint="Estado de descarga/procesamiento de miniaturas"
            />
            <StatCard label="Duración último export" value={formatDuration(detail.latestJob?.durationMs)} hint="Duración total del último job" />
          </div>
        ) : null}
      </section>

      {allWarnings.length > 0 ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">Warnings</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {allWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail ? (
        <section className="panel p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
              <button type="button" className={tabClass(activeTab === "overview")} onClick={() => setActiveTab("overview")}>
                Overview
              </button>
              <button type="button" className={tabClass(activeTab === "playbook")} onClick={() => setActiveTab("playbook")}>
                Playbook
              </button>
              <button type="button" className={tabClass(activeTab === "templates")} onClick={() => setActiveTab("templates")}>
                Templates
              </button>
              <button type="button" className={tabClass(activeTab === "model")} onClick={() => setActiveTab("model")}>
                Model
              </button>
              <button type="button" className={tabClass(activeTab === "jobs")} onClick={() => setActiveTab("jobs")}>
                Jobs
              </button>
            </div>
            <p className="text-xs text-slate-500">Último export: {formatDate(detail.channel.exportedAt ?? null)}</p>
          </div>

          {activeTab === "overview" ? (
            <div className="space-y-4">
              <Section title="Project Overview" hint="Resumen de artifacts y señales de calidad">
                <SectionExplainer>
                  Este proyecto analizó <strong>{detail.manifest?.counts?.totalVideosSelected ?? 0} videos</strong> de{" "}
                  <strong>{detail.channel.channelName}</strong> en un timeframe de{" "}
                  <strong>{detail.channel.timeframe ?? "-"}</strong>. Los artifacts Playbook, Templates y Model
                  contienen los patrones, fórmulas y modelos derivados del análisis.
                </SectionExplainer>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Playbook</p>
                    <Badge variant={detail.artifacts.playbook ? "success" : "warning"}>{detail.artifacts.playbook ? "Disponible" : "No exportado"}</Badge>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Templates</p>
                    <Badge variant={detail.artifacts.templates ? "success" : "warning"}>{detail.artifacts.templates ? "Disponible" : "No exportado"}</Badge>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Channel model</p>
                    <Badge variant={detail.artifacts.channelModels ? "success" : "warning"}>
                      {detail.artifacts.channelModels ? "Disponible" : "No exportado"}
                    </Badge>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Latest job</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{detail.latestJob?.jobId ?? "-"}</p>
                  </article>
                </div>
              </Section>

              {videos.length > 0 ? (
                <Section title="Percentile Distribution" hint="Distribución de rendimiento de videos">
                  <SectionExplainer>
                    Muestra cuántos de los <strong>{videos.length} videos</strong> caen en cada cuartil de rendimiento.
                    Más videos en 75-100 indica un canal con alto rendimiento consistente.
                  </SectionExplainer>
                  <PercentileDistributionChart videos={videos} />
                </Section>
              ) : null}

              <Section title="Top Videos" hint="Ranking por percentile dentro del subset">
                {topVideos.length > 0 ? (
                  <SectionExplainer>
                    Top <strong>{topVideos.length}</strong> videos por percentile. El <strong>residual</strong> mide la
                    diferencia entre vistas reales y esperadas según el modelo del canal: positivo = superó expectativas.
                  </SectionExplainer>
                ) : null}
                {topVideos.length === 0 ? <p className="text-sm text-slate-500">No hay videos para mostrar.</p> : null}
                {topVideos.length > 0 ? (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Video</th>
                          <th className="px-3 py-2">Percentile</th>
                          <th className="px-3 py-2">Residual</th>
                          <th className="px-3 py-2">Views/day</th>
                          <th className="px-3 py-2">Engagement</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {topVideos.map((video) => (
                          <tr key={`top-${video.videoId}`}>
                            <td className="px-3 py-2">
                              <p className="font-medium text-slate-900">{video.title}</p>
                              <p className="text-xs text-slate-500">{video.videoId}</p>
                            </td>
                            <td className="px-3 py-2">{formatPercentile(video.performance?.percentile)}</td>
                            <td className="px-3 py-2">{formatMetric(video.performance?.residual, 3)}</td>
                            <td className="px-3 py-2">{formatMetric(video.performance?.viewsPerDay)}</td>
                            <td className="px-3 py-2">{formatMetric(video.performance?.engagementRate, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </Section>
            </div>
          ) : null}

          {activeTab === "playbook" ? (
            <div>
              <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Re-run Orchestrator</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Vuelve a ejecutar solo el paso del agente orchestrator (LLM) usando los datos ya exportados.
                      Valida que los prerequisitos (channel.json, videos.jsonl, video_features) existan antes de lanzar.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setThumbnailRerunState((prev) => ({
                          ...prev,
                          open: true,
                          error: null
                        }))
                      }
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                    >
                      Recompute thumbnails
                    </button>
                    <button
                      type="button"
                      disabled={rerunState.running || !detail.channel.channelName}
                      onClick={() => void handleRerunOrchestrator()}
                      className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {rerunState.running ? (
                        <>
                          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Ejecutando...
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.598a.75.75 0 00-.75.75v3.634a.75.75 0 001.5 0v-2.033l.312.311a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm-1.873-7.263a7 7 0 00-11.712 3.138.75.75 0 001.449.39 5.5 5.5 0 019.201-2.467l.312.311H10.257a.75.75 0 000 1.5h3.634a.75.75 0 00.75-.75V2.649a.75.75 0 00-1.5 0v2.033l-.312-.311a6.972 6.972 0 00-.39-.21z" clipRule="evenodd" />
                          </svg>
                          Re-run Orchestrator
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {rerunState.error ? (
                  <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
                    <p className="text-sm font-medium text-rose-800">{rerunState.error}</p>
                    {rerunState.checks ? (
                      <ul className="mt-2 space-y-1">
                        {rerunState.checks.map((check) => (
                          <li key={check.artifact} className="flex items-center gap-2 text-xs">
                            <span className={check.exists ? "text-emerald-600" : "text-rose-600"}>
                              {check.exists ? "OK" : "FALTA"}
                            </span>
                            <span className="font-mono text-slate-700">{check.artifact}</span>
                            {check.detail ? <span className="text-slate-500">({check.detail})</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {rerunState.result ? (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <p className="text-sm font-medium text-emerald-800">
                      Orchestrator completado {rerunState.result.usedLlm ? "(LLM)" : "(deterministic fallback)"}
                    </p>
                    {rerunState.result.warnings.length > 0 ? (
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-700">
                        {rerunState.result.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {playbookState.loading ? <p className="text-sm text-slate-600">Cargando playbook...</p> : null}
              {playbookState.error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{playbookState.error}</p> : null}
              {!playbookState.loading && !playbookState.error && !detail.artifacts.playbook ? <ArtifactEmptyState label="Playbook" /> : null}
              {!playbookState.loading && !playbookState.error && detail.artifacts.playbook ? (
                <PlaybookView playbook={playbookState.data} onEvidenceFieldClick={openEvidenceField} debugRawJson={debugRawJson} />
              ) : null}
            </div>
          ) : null}

          {activeTab === "templates" ? (
            <div>
              {templatesState.loading ? <p className="text-sm text-slate-600">Cargando templates...</p> : null}
              {templatesState.error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{templatesState.error}</p> : null}
              {!templatesState.loading && !templatesState.error && !detail.artifacts.templates ? <ArtifactEmptyState label="Templates" /> : null}
              {!templatesState.loading && !templatesState.error && detail.artifacts.templates ? (
                <TemplatesView templates={templatesState.data} onEvidenceFieldClick={openEvidenceField} debugRawJson={debugRawJson} />
              ) : null}
            </div>
          ) : null}

          {activeTab === "model" ? (
            <div>
              {channelModelState.loading ? <p className="text-sm text-slate-600">Cargando model...</p> : null}
              {channelModelState.error ? (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{channelModelState.error}</p>
              ) : null}
              {!channelModelState.loading && !channelModelState.error && !detail.artifacts.channelModels ? (
                <ArtifactEmptyState label="Model" />
              ) : null}
              {!channelModelState.loading && !channelModelState.error && detail.artifacts.channelModels ? (
                <ChannelModelView channelModelArtifact={channelModelState.data} debugRawJson={debugRawJson} />
              ) : null}
            </div>
          ) : null}

          {activeTab === "jobs" ? (
            <Section title={`Jobs (${detail.jobs.length})`}>
              <div className="space-y-2">
                {detail.jobs.length === 0 ? <p className="text-sm text-slate-500">No hay jobs.</p> : null}
                {detail.jobs.map((job) => (
                  <article key={job.jobId} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-slate-900">{job.jobId}</p>
                      <Badge variant={job.status === "done" ? "success" : "danger"}>{job.status}</Badge>
                    </div>
                    <p className="mt-1">finishedAt: {formatDate(job.finishedAt)}</p>
                    <p>duration: {formatDuration(job.durationMs)}</p>
                    <p>warnings/errors: {job.warningsCount}/{job.errorsCount}</p>
                    <p className="mt-1 truncate">summary: {job.summaryPath}</p>
                    <p className="truncate">events: {job.eventsPath}</p>
                    <p className="truncate">errors: {job.errorsPath}</p>
                  </article>
                ))}
              </div>
            </Section>
          ) : null}
        </section>
      ) : null}

      <section className="panel p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Videos ({videos.length})</h2>
          <p className="text-xs text-slate-500">Último export: {formatDate(detail?.channel.exportedAt ?? null)}</p>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-16 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        ) : null}

        {!loading && videos.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-600">
            No hay videos en este proyecto.
          </p>
        ) : null}

        {!loading && videos.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Video</th>
                  <th className="px-3 py-2">
                    <Tooltip content="Ranking relativo dentro del subset">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        Percentile
                      </span>
                    </Tooltip>
                  </th>
                  <th className="px-3 py-2">
                    <Tooltip content="Performance vs baseline model del canal">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        Residual
                      </span>
                    </Tooltip>
                  </th>
                  <th className="px-3 py-2">Views/day • Engagement</th>
                  <th className="px-3 py-2">
                    <Tooltip content="captions, asr o none según origen disponible">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        Transcript
                      </span>
                    </Tooltip>
                  </th>
                  <th className="px-3 py-2">
                    <Tooltip content="Si se reutilizó transcript/thumbnail/derived del cache">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        Cache
                      </span>
                    </Tooltip>
                  </th>
                  <th className="px-3 py-2">LLM</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {videos.map((video) => {
                  const detailData = videoDetailCache[video.videoId];
                  const thumbnailFeatures = asRecord(detailData?.derived ? asRecord(detailData.derived)?.thumbnailFeatures : null);
                  const deterministic = asRecord(thumbnailFeatures?.deterministic);
                  const llm = asRecord(thumbnailFeatures?.llm);
                  const ocrText = asString(deterministic?.ocrText);
                  const ocrConfidence =
                    typeof deterministic?.ocrConfidenceMean === "number" ? deterministic.ocrConfidenceMean : null;
                  const ocrWordCountHiConf =
                    typeof deterministic?.ocrWordCountHiConf === "number" ? deterministic.ocrWordCountHiConf : null;
                  const hasBigText = deterministic?.hasBigText;
                  const archetype = asString(llm?.archetype);
                  const isThumbnailLoading = thumbnailLoadingIds.includes(video.videoId);

                  return (
                    <tr key={video.videoId}>
                      <td className="px-3 py-2">
                        <div className="flex min-w-[320px] items-center gap-3">
                          <Tooltip
                            side="right"
                            content={
                              <div className="max-w-[320px] space-y-1">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Thumbnail Preview</p>
                                <p className="text-xs text-slate-100">
                                  ocrText: <span className="text-slate-200">{ocrText ?? (isThumbnailLoading ? "Cargando..." : "-")}</span>
                                </p>
                                <p className="text-xs text-slate-100">ocrConfidence: {formatMetric(ocrConfidence, 3)}</p>
                                <p className="text-xs text-slate-100">hiConfWords: {valueToText(ocrWordCountHiConf)}</p>
                                <p className="text-xs text-slate-100">hasBigText: {valueToText(hasBigText)}</p>
                                <p className="text-xs text-slate-100">archetype: {archetype ?? "-"}</p>
                              </div>
                            }
                          >
                            <button
                              type="button"
                              className="rounded-lg border border-slate-200"
                              onMouseEnter={() => void prefetchVideoDetailForThumbnail(video.videoId)}
                              onFocus={() => void prefetchVideoDetailForThumbnail(video.videoId)}
                            >
                              <img
                                src={`/api/projects/${encodeURIComponent(projectId)}/thumb/${encodeURIComponent(video.videoId)}`}
                                alt={video.title}
                                loading="lazy"
                                className="h-14 w-24 rounded-lg object-cover"
                              />
                            </button>
                          </Tooltip>
                          <div>
                            <p className="font-semibold text-slate-900">{video.title}</p>
                            <p className="text-xs text-slate-500">{formatDate(video.publishedAt)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={percentileVariant(video.performance?.percentile)}>{formatPercentile(video.performance?.percentile)}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={residualVariant(video.performance?.residual)}>{formatMetric(video.performance?.residual, 3)}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-700">
                        <p>vpd: {formatMetric(video.performance?.viewsPerDay)}</p>
                        <p>eng: {formatMetric(video.performance?.engagementRate, 3)}</p>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <Badge variant={transcriptVariant(video.transcriptStatus)}>{video.transcriptStatus}</Badge>
                        <p className="mt-1 text-slate-500">{video.transcriptSource}</p>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <Badge variant={cacheVariant(video.cacheHit)}>{video.cacheHit ?? "-"}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-700">
                        <p>desc: {video.hasLLM.description ? "yes" : "no"}</p>
                        <p>trans: {video.hasLLM.transcript ? "yes" : "no"}</p>
                        <p>thumb: {video.hasLLM.thumbnail ? "yes" : "no"}</p>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => void openVideoDetail(video.videoId)} className="btn-secondary !rounded-lg !px-3 !py-1.5 !text-xs">
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {thumbnailRerunState.open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Recompute thumbnails">
          <section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Recompute thumbnails</h3>
                <p className="text-xs text-slate-500">
                  Recalcula deterministic + OCR + LLM y refresca los artifacts derivados del proyecto.
                </p>
              </div>
              <button type="button" className="btn-ghost !rounded-lg !px-3 !py-1.5 !text-xs" onClick={closeThumbnailRerunModal} disabled={thumbnailRerunState.running}>
                Cerrar
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-700">
                Scope
                <select
                  value={thumbnailRerunState.scope}
                  onChange={(event) =>
                    setThumbnailRerunState((prev) => ({
                      ...prev,
                      scope: event.target.value as ThumbnailRerunScope
                    }))
                  }
                  disabled={thumbnailRerunState.running}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                >
                  <option value="all">All videos</option>
                  <option value="exemplars">Exemplars only</option>
                  <option value="selected">Selected videoIds</option>
                </select>
              </label>

              <label className="text-xs font-medium text-slate-700">
                OCR Engine
                <select
                  value={thumbnailRerunState.engine}
                  onChange={(event) =>
                    setThumbnailRerunState((prev) => ({
                      ...prev,
                      engine: event.target.value as ThumbnailRerunEngine
                    }))
                  }
                  disabled={thumbnailRerunState.running}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                >
                  <option value="python">python</option>
                  <option value="auto">auto</option>
                </select>
              </label>
            </div>

            {thumbnailRerunState.scope === "selected" ? (
              <label className="mt-3 block text-xs font-medium text-slate-700">
                videoIds (coma o salto de línea)
                <textarea
                  value={thumbnailRerunState.selectedVideoIdsInput}
                  onChange={(event) =>
                    setThumbnailRerunState((prev) => ({
                      ...prev,
                      selectedVideoIdsInput: event.target.value
                    }))
                  }
                  disabled={thumbnailRerunState.running}
                  rows={4}
                  placeholder="videoA1, videoA2"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                />
              </label>
            ) : null}

            <label className="mt-3 inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={thumbnailRerunState.force}
                onChange={(event) =>
                  setThumbnailRerunState((prev) => ({
                    ...prev,
                    force: event.target.checked
                  }))
                }
                disabled={thumbnailRerunState.running}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              Force recompute (ignorar cache)
            </label>

            <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={thumbnailRerunState.redownloadMissingThumbnails}
                onChange={(event) =>
                  setThumbnailRerunState((prev) => ({
                    ...prev,
                    redownloadMissingThumbnails: event.target.checked
                  }))
                }
                disabled={thumbnailRerunState.running}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              Re-descargar thumbnails faltantes antes de correr OCR
            </label>
            <p className="mt-1 text-xs text-slate-500">
              Solo intenta bajar miniaturas cuando el archivo local no existe.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRecomputeThumbnails()}
                disabled={thumbnailRerunState.running}
                className="btn-primary !rounded-lg !px-3 !py-2 !text-xs"
              >
                {thumbnailRerunState.running ? "Procesando..." : "Start rerun"}
              </button>
              {thumbnailRerunState.auditArtifactPath ? (
                <p className="text-xs text-slate-500">Audit: {thumbnailRerunState.auditArtifactPath}</p>
              ) : null}
            </div>

            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <p>
                Progreso: <strong>{thumbnailRerunState.completed}</strong>/{thumbnailRerunState.total} · processed{" "}
                <strong>{thumbnailRerunState.processed}</strong> · skipped <strong>{thumbnailRerunState.skipped}</strong> · failed{" "}
                <strong>{thumbnailRerunState.failed}</strong>
              </p>
            </div>

            {thumbnailRerunState.error ? (
              <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{thumbnailRerunState.error}</p>
            ) : null}

            {thumbnailRerunState.videoErrors.length > 0 ? (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <p className="text-xs font-semibold text-rose-800">Errores por video</p>
                <ul className="mt-2 max-h-32 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-rose-700">
                  {thumbnailRerunState.videoErrors.map((item, index) => (
                    <li key={`${item.videoId}-${index}`}>
                      {item.videoId}: {item.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {thumbnailRerunState.warnings.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold text-amber-800">Warnings</p>
                <ul className="mt-2 max-h-32 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-amber-700">
                  {thumbnailRerunState.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {evidencePanel.open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/35 p-4" role="dialog" aria-modal="true" aria-label="Evidence field detail">
          <section className="h-full w-full max-w-2xl overflow-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Evidence Field Drill-down</h3>
                <p className="font-mono text-xs text-slate-600">{evidencePanel.fieldPath}</p>
              </div>
              <button type="button" onClick={() => setEvidencePanel({ open: false, fieldPath: "", supportedBy: [] })} className="btn-ghost !rounded-lg !px-3 !py-1.5 !text-xs">
                Cerrar
              </button>
            </div>

            {evidenceLoading ? <p className="text-sm text-slate-600">Cargando evidencia de videos...</p> : null}
            {evidenceError ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{evidenceError}</p> : null}

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Video ID</th>
                    <th className="px-3 py-2">Value</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {evidenceRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-sm text-slate-500">
                        Sin valores para mostrar.
                      </td>
                    </tr>
                  ) : null}
                  {evidenceRows.map((row) => (
                    <tr key={`evidence-${row.videoId}`}>
                      <td className="px-3 py-2 font-mono text-xs text-slate-800">{row.videoId}</td>
                      <td className="px-3 py-2 text-slate-700">
                        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{row.value}</code>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" className="btn-ghost !rounded-lg !px-3 !py-1.5 !text-xs" onClick={() => void openVideoDetail(row.videoId)}>
                          Abrir video
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {selectedVideoId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Video details">
          <section className="max-h-[90vh] w-full max-w-6xl overflow-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Video Details: {selectedVideoId}</h3>
              <button onClick={closeVideoDetail} className="btn-ghost !rounded-lg !px-3 !py-1.5 !text-xs">
                Cerrar
              </button>
            </div>

            {videoDetailLoading ? <p className="text-sm text-slate-600">Cargando detalle...</p> : null}
            {videoDetailError ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{videoDetailError}</p> : null}

            {!videoDetailLoading && selectedVideoDetail ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-slate-900">Derived JSON</h4>
                  <JsonBlock value={selectedVideoDetail.derived} />
                  <h4 className="mb-2 mt-4 text-sm font-semibold text-slate-900">Raw Video</h4>
                  <JsonBlock value={selectedVideoDetail.rawVideo} />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">Transcript segments</h4>
                    <input
                      type="text"
                      value={transcriptSearch}
                      onChange={(event) => setTranscriptSearch(event.target.value)}
                      placeholder="Buscar en transcript"
                      className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    />
                  </div>
                  {selectedVideoDetail.transcriptJsonl == null ? <p className="text-sm text-slate-500">No transcript disponible.</p> : null}
                  {selectedVideoDetail.transcriptJsonl != null ? (
                    <pre className="max-h-[58vh] overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
                      {JSON.stringify(transcriptRows, null, 2)}
                    </pre>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {debugRawJson ? (
        <Collapsible title="Raw Dashboard JSON (debug)" defaultOpen={false}>
          <JsonBlock
            value={{
              detail,
              playbook: playbookState.data,
              templates: templatesState.data,
              channelModel: channelModelState.data
            }}
          />
        </Collapsible>
      ) : null}
    </div>
  );
}
