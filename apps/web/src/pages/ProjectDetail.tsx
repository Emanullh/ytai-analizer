import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ProjectDetailResponse, ProjectVideoDetail, ProjectVideoSummary } from "../types";

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

function statusBadge(status: "ok" | "missing" | "error"): string {
  if (status === "ok") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (status === "missing") {
    return "bg-amber-100 text-amber-700";
  }
  return "bg-rose-100 text-rose-700";
}

function cacheHitBadge(cacheHit: ProjectVideoSummary["cacheHit"]): string {
  if (cacheHit === "full") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (cacheHit === "partial") {
    return "bg-sky-100 text-sky-700";
  }
  if (cacheHit === "miss") {
    return "bg-slate-200 text-slate-700";
  }
  return "bg-slate-100 text-slate-600";
}

function numberOrDash(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(2);
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

export default function ProjectDetail() {
  const { projectId: projectIdParam } = useParams<{ projectId: string }>();
  const projectId = projectIdParam ? decodeURIComponent(projectIdParam) : "";

  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [videos, setVideos] = useState<ProjectVideoSummary[]>([]);
  const [playbook, setPlaybook] = useState<Record<string, unknown> | null>(null);
  const [templates, setTemplates] = useState<Record<string, unknown> | null>(null);
  const [channelModels, setChannelModels] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedVideoDetail, setSelectedVideoDetail] = useState<ProjectVideoDetail | null>(null);
  const [videoDetailLoading, setVideoDetailLoading] = useState(false);
  const [videoDetailError, setVideoDetailError] = useState<string | null>(null);
  const [transcriptSearch, setTranscriptSearch] = useState("");

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

    const fetchOptionalJson = async (url: string): Promise<Record<string, unknown> | null> => {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as Record<string, unknown>;
    };

    const run = async () => {
      setLoading(true);
      setError(null);
      setSelectedVideoId(null);
      setSelectedVideoDetail(null);
      setPlaybook(null);
      setTemplates(null);
      setChannelModels(null);

      try {
        const encodedId = encodeURIComponent(projectId);
        const [projectDetail, projectVideos] = await Promise.all([
          fetchJson<ProjectDetailResponse>(`/api/projects/${encodedId}`),
          fetchJson<ProjectVideoSummary[]>(`/api/projects/${encodedId}/videos`)
        ]);

        const [playbookJson, templatesJson, channelModelsJson] = await Promise.all([
          projectDetail.artifacts.playbook
            ? fetchOptionalJson(`/api/projects/${encodedId}/artifacts/playbook`)
            : Promise.resolve(null),
          projectDetail.artifacts.templates
            ? fetchOptionalJson(`/api/projects/${encodedId}/artifacts/templates`)
            : Promise.resolve(null),
          projectDetail.artifacts.channelModels
            ? fetchOptionalJson(`/api/projects/${encodedId}/artifacts/channel_models`)
            : Promise.resolve(null)
        ]);

        if (!canceled) {
          setDetail(projectDetail);
          setVideos(projectVideos);
          setPlaybook(playbookJson);
          setTemplates(templatesJson);
          setChannelModels(channelModelsJson);
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

  const allWarnings = useMemo(() => {
    const fromManifest = Array.isArray(detail?.manifest?.warnings)
      ? (detail?.manifest?.warnings.filter((item): item is string => typeof item === "string") ?? [])
      : [];
    const merged = [...(detail?.warnings ?? []), ...fromManifest];
    return Array.from(new Set(merged));
  }, [detail]);

  const openVideoDetail = async (videoId: string) => {
    if (!projectId) {
      return;
    }

    setSelectedVideoId(videoId);
    setVideoDetailLoading(true);
    setVideoDetailError(null);
    setTranscriptSearch("");

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}?maxSegments=200`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "No fue posible cargar detalles del video.");
      }

      const payload = (await response.json()) as ProjectVideoDetail;
      setSelectedVideoDetail(payload);
    } catch (requestError) {
      setVideoDetailError(requestError instanceof Error ? requestError.message : "Error inesperado.");
      setSelectedVideoDetail(null);
    } finally {
      setVideoDetailLoading(false);
    }
  };

  const closeVideoDetail = () => {
    setSelectedVideoId(null);
    setSelectedVideoDetail(null);
    setVideoDetailError(null);
    setTranscriptSearch("");
  };

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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Project</p>
            <h1 className="text-2xl font-semibold text-slate-900">{detail?.channel.channelName ?? projectId}</h1>
            <p className="mt-1 text-xs text-slate-500">{projectId}</p>
          </div>
          <Link to="/projects" className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200">
            Volver a Projects
          </Link>
        </div>

        {loading ? <p className="mt-4 text-sm text-slate-600">Cargando proyecto...</p> : null}
        {error ? <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

        {detail ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Videos seleccionados</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{detail.manifest?.counts?.totalVideosSelected ?? 0}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Transcripts OK</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{detail.manifest?.counts?.transcriptsOk ?? 0}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Transcripts Missing/Error</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">
                {(detail.manifest?.counts?.transcriptsMissing ?? 0) + (detail.manifest?.counts?.transcriptsError ?? 0)}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Thumbnails OK/Failed</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">
                {detail.manifest?.counts?.thumbnailsOk ?? 0}/{detail.manifest?.counts?.thumbnailsFailed ?? 0}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Duración último export</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{formatDuration(detail.latestJob?.durationMs)}</p>
            </div>
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
        <section className="grid gap-4 lg:grid-cols-3">
          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" open>
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">Playbook</summary>
            <div className="mt-3">
              <JsonBlock value={playbook} />
            </div>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" open>
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">Templates</summary>
            <div className="mt-3">
              <JsonBlock value={templates} />
            </div>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">Jobs ({detail.jobs.length})</summary>
            <div className="mt-3 space-y-2">
              {detail.jobs.length === 0 ? <p className="text-sm text-slate-500">No hay jobs.</p> : null}
              {detail.jobs.map((job) => (
                <article key={job.jobId} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900">{job.jobId}</p>
                    <span className={`rounded-full px-2 py-0.5 ${job.status === "done" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {job.status}
                    </span>
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
          </details>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
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
                  <th className="px-3 py-2">Performance</th>
                  <th className="px-3 py-2">Transcript</th>
                  <th className="px-3 py-2">Cache</th>
                  <th className="px-3 py-2">LLM</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {videos.map((video) => (
                  <tr key={video.videoId}>
                    <td className="px-3 py-2">
                      <div className="flex min-w-[280px] items-center gap-3">
                        <img
                          src={`/api/projects/${encodeURIComponent(projectId)}/thumb/${encodeURIComponent(video.videoId)}`}
                          alt={video.title}
                          loading="lazy"
                          className="h-14 w-24 rounded-lg border border-slate-200 object-cover"
                        />
                        <div>
                          <p className="font-semibold text-slate-900">{video.title}</p>
                          <p className="text-xs text-slate-500">{formatDate(video.publishedAt)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      <p>pct: {numberOrDash(video.performance?.percentile)}</p>
                      <p>residual: {numberOrDash(video.performance?.residual)}</p>
                      <p>vpd: {numberOrDash(video.performance?.viewsPerDay)}</p>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`rounded-full px-2 py-1 font-semibold ${statusBadge(video.transcriptStatus)}`}>
                        {video.transcriptStatus}
                      </span>
                      <p className="mt-1 text-slate-500">{video.transcriptSource}</p>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`rounded-full px-2 py-1 font-semibold ${cacheHitBadge(video.cacheHit)}`}>{video.cacheHit ?? "-"}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      <p>desc: {video.hasLLM.description ? "yes" : "no"}</p>
                      <p>trans: {video.hasLLM.transcript ? "yes" : "no"}</p>
                      <p>thumb: {video.hasLLM.thumbnail ? "yes" : "no"}</p>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => openVideoDetail(video.videoId)}
                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {channelModels ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Channel Models</h2>
          <div className="mt-3">
            <JsonBlock value={channelModels} />
          </div>
        </section>
      ) : null}

      {selectedVideoId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Video details">
          <section className="max-h-[90vh] w-full max-w-6xl overflow-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Video Details: {selectedVideoId}</h3>
              <button onClick={closeVideoDetail} className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200">
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
    </div>
  );
}
