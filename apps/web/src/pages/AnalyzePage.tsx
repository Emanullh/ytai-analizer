import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createInitialExportModalState, reduceExportModalState } from "../exportJobState";
import { AnalyzeResponse, ExportJobCreateResponse, ExportSseEvent, ExportVideoStage, Timeframe, VideoItem } from "../types";
import Tooltip from "../components/Tooltip";

const timeframeOptions: Array<{ label: string; value: Timeframe }> = [
  { label: "Último mes", value: "1m" },
  { label: "Últimos 6 meses", value: "6m" },
  { label: "Último año", value: "1y" }
];

const stageLabelByKey: Record<ExportVideoStage, string> = {
  queue: "En cola",
  downloading_audio: "Descargando audio",
  transcribing: "Transcribiendo",
  downloading_thumbnail: "Descargando miniatura",
  writing_json: "Escribiendo JSON",
  done: "Completado",
  warning: "Completado con warning",
  failed: "Falló"
};

const stageHintByKey: Record<ExportVideoStage, string> = {
  queue: "Video en cola antes de iniciar procesamiento.",
  downloading_audio: "Descarga o reutilización del MP3 para Local ASR.",
  transcribing: "Extracción del transcript usando Local ASR.",
  downloading_thumbnail: "Descarga/procesamiento de miniatura.",
  writing_json: "Escritura de artifacts raw/derived.",
  done: "Video exportado sin incidencias.",
  warning: "Video exportado, con warning en alguna etapa.",
  failed: "Video no pudo exportarse."
};

function formatViews(views: number): string {
  return new Intl.NumberFormat("es-ES").format(views);
}

function stageBadgeClasses(stage: ExportVideoStage): string {
  if (stage === "done") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (stage === "warning") {
    return "bg-amber-100 text-amber-700";
  }
  if (stage === "failed") {
    return "bg-rose-100 text-rose-700";
  }
  if (stage === "transcribing") {
    return "bg-sky-100 text-sky-700";
  }
  return "bg-slate-100 text-slate-700";
}

export default function AnalyzePage() {
  const [sourceInput, setSourceInput] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe>("6m");
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "analyzing" | "exporting">("idle");
  const [exportModalState, dispatchExportModal] = useReducer(reduceExportModalState, undefined, createInitialExportModalState);
  const eventSourceRef = useRef<EventSource | null>(null);

  const hasSelection = selectedVideoIds.size > 0;
  const sortedVideos: VideoItem[] = useMemo(
    () =>
      result?.videos.slice().sort((a, b) => {
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      }) ?? [],
    [result]
  );

  const videoTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const video of sortedVideos) {
      map.set(video.videoId, video.title);
    }
    return map;
  }, [sortedVideos]);

  const exportProgressPercent =
    exportModalState.total > 0 ? Math.round((exportModalState.completed / exportModalState.total) * 100) : 0;

  const toggleVideo = (videoId: string) => {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
  };

  const handleAnalyze = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!sourceInput.trim()) {
      setError("Ingresa una URL de canal, @handle, /user o /c.");
      return;
    }

    try {
      setStatus("analyzing");
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceInput: sourceInput.trim(),
          timeframe
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "No fue posible analizar el canal.");
      }

      const payload = (await response.json()) as AnalyzeResponse;
      setResult(payload);
      setSelectedVideoIds(new Set());
    } catch (requestError) {
      setResult(null);
      setSelectedVideoIds(new Set());
      setError(requestError instanceof Error ? requestError.message : "Error inesperado.");
    } finally {
      setStatus("idle");
    }
  };

  const handleExport = async () => {
    if (!result || !hasSelection) {
      return;
    }

    setError(null);
    const selected = Array.from(selectedVideoIds);
    dispatchExportModal({
      type: "start",
      videoIds: selected
    });

    try {
      setStatus("exporting");
      const response = await fetch("/api/export/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: result.channelId,
          channelName: result.channelName,
          sourceInput: result.sourceInput,
          timeframe: result.timeframe,
          selectedVideoIds: selected
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "No fue posible exportar.");
      }

      const payload = (await response.json()) as ExportJobCreateResponse;
      dispatchExportModal({ type: "job_created", jobId: payload.jobId });

      eventSourceRef.current?.close();
      const eventSource = new EventSource(`/api/export/jobs/${payload.jobId}/events`);
      eventSourceRef.current = eventSource;
      let closedByTerminalEvent = false;

      const handleEvent = (eventName: ExportSseEvent["event"]) => (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as ExportSseEvent["data"];
          const typedEvent = { event: eventName, data } as ExportSseEvent;

          dispatchExportModal({ type: "event", payload: typedEvent });

          if (eventName === "job_done" || eventName === "job_failed") {
            closedByTerminalEvent = true;
            eventSource.close();
            if (eventSourceRef.current === eventSource) {
              eventSourceRef.current = null;
            }
            setStatus("idle");
          }
        } catch {
          dispatchExportModal({
            type: "request_failed",
            message: "No se pudo leer un evento de progreso del export."
          });
          setStatus("idle");
        }
      };

      const eventNames: ExportSseEvent["event"][] = [
        "job_started",
        "video_progress",
        "job_progress",
        "warning",
        "job_done",
        "job_failed"
      ];
      for (const eventName of eventNames) {
        eventSource.addEventListener(eventName, handleEvent(eventName));
      }

      eventSource.onerror = () => {
        if (closedByTerminalEvent) {
          return;
        }
        eventSource.close();
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
        }
        dispatchExportModal({
          type: "request_failed",
          message: "Se perdió la conexión de progreso con el export."
        });
        setStatus("idle");
      };
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Error inesperado.");
      dispatchExportModal({
        type: "request_failed",
        message: requestError instanceof Error ? requestError.message : "Error inesperado."
      });
      setStatus("idle");
    }
  };

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <section className="panel p-5">
        <h1 className="text-2xl font-semibold text-slate-900">YTAI Analyzer</h1>
        <p className="mt-1 text-sm text-slate-600">Analiza videos por canal y exporta los seleccionados.</p>

        <form className="mt-5 grid gap-3 lg:grid-cols-[1fr_220px_180px]" onSubmit={handleAnalyze}>
          <label className="text-sm font-medium text-slate-700">
            Canal (URL, @handle, /c, /user o handle)
            <input
              type="text"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
              placeholder="https://www.youtube.com/@midudev"
              autoComplete="off"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>

          <label className="text-sm font-medium text-slate-700">
            Timeframe
            <select
              value={timeframe}
              onChange={(event) => setTimeframe(event.target.value as Timeframe)}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            >
              {timeframeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" disabled={status !== "idle"} className="btn-primary">
            {status === "analyzing" ? "Analizando..." : "Analizar"}
          </button>
        </form>

        {error ? <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

        {result?.warnings.length ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p className="font-semibold">Warnings</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {result ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <p className="text-base font-semibold text-slate-900">{result.channelName}</p>
            <p>
              Channel ID: <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">{result.channelId}</code>
            </p>
            <p>Videos encontrados: {result.videos.length}</p>
          </div>
        ) : null}
      </section>

      {result ? (
        <section className="panel p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Videos</h2>
            <button
              disabled={!hasSelection || status !== "idle"}
              onClick={handleExport}
              className="btn-secondary"
            >
              {status === "exporting" ? "Exportando..." : "Exportar seleccionados"}
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {sortedVideos.map((video) => {
              const selected = selectedVideoIds.has(video.videoId);
              return (
                <article
                  key={video.videoId}
                  className={`overflow-hidden rounded-2xl border bg-white transition ${
                    selected
                      ? "border-teal-400 ring-2 ring-teal-100"
                      : "border-slate-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                  }`}
                  onClick={() => toggleVideo(video.videoId)}
                >
                  <img src={video.thumbnailUrl} alt={video.title} loading="lazy" className="aspect-video w-full object-cover" />
                  <div className="space-y-2 p-3">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleVideo(video.videoId)}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      Seleccionar
                    </label>
                    <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">{video.title}</h3>
                    <p className="text-sm text-slate-600">{formatViews(video.viewCount)} vistas</p>
                    <p className="text-xs text-slate-500">{new Date(video.publishedAt).toLocaleDateString("es-ES")}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {exportModalState.isOpen ? (
        <div
          className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl sm:inset-x-6 sm:bottom-6 sm:max-h-[calc(100dvh-3rem)]"
          role="dialog"
          aria-modal="false"
          aria-label="Progreso de exportación"
        >
          <section className="panel flex min-h-0 w-full flex-col overflow-hidden p-4 shadow-2xl shadow-slate-900/20">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900">Progreso de export</h3>
              <button
                type="button"
                className="btn-ghost !rounded-lg !px-3 !py-1.5 !text-xs !font-medium"
                onClick={() => dispatchExportModal({ type: "close" })}
                disabled={exportModalState.status === "starting"}
              >
                Cerrar
              </button>
            </div>

            <div className="mt-3 grid min-h-0 gap-3 overflow-y-auto pr-1">
              {exportModalState.status === "starting" ? <p className="text-sm text-slate-600">Preparando export...</p> : null}
              <p className="text-sm text-slate-700">
                General: <span className="font-semibold">{exportModalState.completed}</span>/{exportModalState.total}
              </p>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200" aria-hidden>
                <div className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 transition-all" style={{ width: `${exportProgressPercent}%` }} />
              </div>

              <div className="max-h-56 space-y-2 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
                {Object.entries(exportModalState.videoStages).map(([videoId, stage]) => (
                  <div key={videoId} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5 text-xs">
                    <span className="truncate text-slate-700" title={videoTitleById.get(videoId) ?? videoId}>
                      {videoTitleById.get(videoId) ?? videoId}
                    </span>
                    <Tooltip content={stageHintByKey[stage]}>
                      <span tabIndex={0} className={`cursor-help rounded-full px-2 py-0.5 font-medium ${stageBadgeClasses(stage)}`}>
                        {stageLabelByKey[stage]}
                      </span>
                    </Tooltip>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stages</p>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {Object.entries(stageLabelByKey).map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5 text-xs">
                      <span className="text-slate-700">{label}</span>
                      <Tooltip content={stageHintByKey[key as ExportVideoStage]}>
                        <span tabIndex={0} className="cursor-help rounded-full border border-slate-300 px-1.5 text-slate-500">
                          ?
                        </span>
                      </Tooltip>
                    </div>
                  ))}
                </div>
              </div>

              {exportModalState.warnings.length ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <p className="font-semibold">Warnings</p>
                  <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5">
                    {exportModalState.warnings.map((warning, index) => (
                      <li key={`${warning}-${index}`}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {exportModalState.status === "done" && exportModalState.exportPath ? (
                <div className="space-y-2">
                  <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    Export finalizado en: <code>{exportModalState.exportPath}</code>
                  </p>
                  <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
                    El export principal deja listos raw/features/model. Si luego necesitas Playbook o Templates, ejecútalos manualmente desde Projects con <strong>Re-run Orchestrator</strong>.
                  </p>
                </div>
              ) : null}

              {exportModalState.status === "failed" && exportModalState.error ? (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{exportModalState.error}</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
