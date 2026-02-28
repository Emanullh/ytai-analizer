import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import "./index.css";
import { createInitialExportModalState, reduceExportModalState } from "./exportJobState";
import { AnalyzeResponse, ExportJobCreateResponse, ExportSseEvent, ExportVideoStage, Timeframe, VideoItem } from "./types";

const timeframeOptions: Array<{ label: string; value: Timeframe }> = [
  { label: "Último mes", value: "1m" },
  { label: "Últimos 6 meses", value: "6m" },
  { label: "Último año", value: "1y" }
];

function formatViews(views: number): string {
  return new Intl.NumberFormat("es-ES").format(views);
}

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

function App() {
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
      dispatchExportModal({
        type: "job_created",
        jobId: payload.jobId
      });

      eventSourceRef.current?.close();
      const eventSource = new EventSource(`/api/export/jobs/${payload.jobId}/events`);
      eventSourceRef.current = eventSource;
      let closedByTerminalEvent = false;

      const handleEvent = (eventName: ExportSseEvent["event"]) => (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as ExportSseEvent["data"];
          const typedEvent = {
            event: eventName,
            data
          } as ExportSseEvent;

          dispatchExportModal({
            type: "event",
            payload: typedEvent
          });

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
    <main className="page">
      <section className="panel">
        <h1>YTAI Analyzer</h1>
        <p className="subtitle">Analiza videos por canal y exporta los seleccionados.</p>

        <form className="controls" onSubmit={handleAnalyze}>
          <label className="field">
            Canal (URL, @handle, /c, /user o handle)
            <input
              type="text"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
              placeholder="https://www.youtube.com/@midudev"
              autoComplete="off"
            />
          </label>

          <label className="field">
            Timeframe
            <select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe)}>
              {timeframeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" disabled={status !== "idle"}>
            {status === "analyzing" ? "Analizando..." : "Analizar"}
          </button>
        </form>

        {error ? <p className="alert error">{error}</p> : null}
        {result?.warnings.length ? (
          <div className="alert warning">
            <strong>Warnings:</strong>
            <ul>
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {result ? (
          <div className="summary">
            <h2>{result.channelName}</h2>
            <p>
              Channel ID: <code>{result.channelId}</code>
            </p>
            <p>Videos encontrados: {result.videos.length}</p>
          </div>
        ) : null}
      </section>

      {result ? (
        <section className="panel">
          <div className="export-row">
            <h2>Videos</h2>
            <button disabled={!hasSelection || status !== "idle"} onClick={handleExport}>
              {status === "exporting" ? "Exportando..." : "Exportar seleccionados"}
            </button>
          </div>

          <div className="grid">
            {sortedVideos.map((video) => (
              <article
                key={video.videoId}
                className={`card ${selectedVideoIds.has(video.videoId) ? "selected" : ""}`}
                onClick={() => toggleVideo(video.videoId)}
              >
                <img src={video.thumbnailUrl} alt={video.title} loading="lazy" />
                <div className="card-content">
                  <label className="checkbox-row" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedVideoIds.has(video.videoId)}
                      onChange={() => toggleVideo(video.videoId)}
                    />
                    Seleccionar
                  </label>
                  <h3>{video.title}</h3>
                  <p>{formatViews(video.viewCount)} vistas</p>
                  <small>{new Date(video.publishedAt).toLocaleDateString("es-ES")}</small>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {exportModalState.isOpen ? (
        <div className="export-modal-wrap" role="dialog" aria-modal="false" aria-label="Progreso de exportación">
          <section className="export-modal">
            <div className="export-modal-header">
              <h3>Progreso de export</h3>
              <button
                type="button"
                className="secondary"
                onClick={() => dispatchExportModal({ type: "close" })}
                disabled={exportModalState.status === "starting"}
              >
                Cerrar
              </button>
            </div>

            {exportModalState.status === "starting" ? <p>Preparando export...</p> : null}
            <p>
              General: {exportModalState.completed}/{exportModalState.total}
            </p>
            <div className="progress-track" aria-hidden>
              <div className="progress-fill" style={{ width: `${exportProgressPercent}%` }} />
            </div>

            <div className="export-video-list">
              {Object.entries(exportModalState.videoStages).map(([videoId, stage]) => (
                <div key={videoId} className="export-video-row">
                  <span title={videoTitleById.get(videoId) ?? videoId}>{videoTitleById.get(videoId) ?? videoId}</span>
                  <strong>{stageLabelByKey[stage]}</strong>
                </div>
              ))}
            </div>

            {exportModalState.warnings.length ? (
              <div className="alert warning">
                <strong>Warnings:</strong>
                <ul>
                  {exportModalState.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {exportModalState.status === "done" && exportModalState.exportPath ? (
              <p>
                Export finalizado en: <code>{exportModalState.exportPath}</code>
              </p>
            ) : null}
            {exportModalState.status === "failed" && exportModalState.error ? (
              <p className="alert error">{exportModalState.error}</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
