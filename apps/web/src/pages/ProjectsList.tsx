import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ProjectListItem } from "../types";

function statusClasses(status: ProjectListItem["status"]): string {
  if (status === "ok") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (status === "partial") {
    return "bg-amber-100 text-amber-700";
  }
  if (status === "failed") {
    return "bg-rose-100 text-rose-700";
  }
  return "bg-slate-100 text-slate-700";
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("es-ES");
}

type BundleButtonState = "idle" | "loading" | "success" | "error";

interface BundleMetaResponse {
  exportJobId: string;
  estimatedSizeMb: number;
  confirmationThresholdMb: number;
  confirmationRequired: boolean;
}

interface ToastMessage {
  id: number;
  type: "success" | "error" | "info";
  message: string;
}

function toastClass(type: ToastMessage["type"]): string {
  if (type === "success") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (type === "error") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-white text-slate-700";
}

function parseFileNameFromDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const quotedMatch = contentDisposition.match(/filename=\"([^\"]+)\"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }
  const plainMatch = contentDisposition.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() ?? null;
}

export default function ProjectsList() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [bundleStates, setBundleStates] = useState<Record<string, BundleButtonState>>({});
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastCounterRef = useRef(0);

  const pushToast = useCallback((type: ToastMessage["type"], message: string) => {
    const id = ++toastCounterRef.current;
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  const setBundleState = useCallback((projectId: string, state: BundleButtonState) => {
    setBundleStates((prev) => ({ ...prev, [projectId]: state }));
    if (state === "success" || state === "error") {
      window.setTimeout(() => {
        setBundleStates((prev) => {
          if (prev[projectId] !== state) {
            return prev;
          }
          return { ...prev, [projectId]: "idle" };
        });
      }, 3000);
    }
  }, []);

  const handleExportBundle = useCallback(
    async (projectId: string) => {
      if (bundleStates[projectId] === "loading") {
        return;
      }

      setBundleState(projectId, "loading");

      try {
        const encodedProjectId = encodeURIComponent(projectId);
        const metaResponse = await fetch(`/api/projects/${encodedProjectId}/bundle/meta?export=latest`);
        if (!metaResponse.ok) {
          const payload = (await metaResponse.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "No fue posible estimar el bundle.");
        }
        const meta = (await metaResponse.json()) as BundleMetaResponse;

        if (meta.confirmationRequired) {
          const confirmed = window.confirm(
            `El bundle estimado pesa ${meta.estimatedSizeMb.toFixed(2)} MB (umbral ${meta.confirmationThresholdMb} MB). ¿Continuar?`
          );
          if (!confirmed) {
            setBundleState(projectId, "idle");
            pushToast("info", "Exportación cancelada.");
            return;
          }
        }

        const bundleResponse = await fetch(`/api/projects/${encodedProjectId}/bundle?export=latest`);
        if (!bundleResponse.ok) {
          const payload = (await bundleResponse.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "No fue posible generar el bundle.");
        }
        const blob = await bundleResponse.blob();
        const fileName =
          parseFileNameFromDisposition(bundleResponse.headers.get("content-disposition")) ??
          `bundle_${projectId}_${meta.exportJobId}.zip`;

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);

        setBundleState(projectId, "success");
        pushToast("success", `Bundle exportado (${meta.exportJobId}).`);
      } catch (requestError) {
        setBundleState(projectId, "error");
        pushToast("error", requestError instanceof Error ? requestError.message : "Error inesperado.");
      }
    },
    [bundleStates, pushToast, setBundleState]
  );

  useEffect(() => {
    let canceled = false;

    const run = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/projects");
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "No fue posible cargar proyectos.");
        }

        const payload = (await response.json()) as ProjectListItem[];
        if (!canceled) {
          setProjects(payload);
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
  }, []);

  const filteredProjects = useMemo(() => {
    const term = search.trim().toLowerCase();
    const sorted = [...projects].sort((a, b) => {
      const timeA = a.lastExportedAt ? new Date(a.lastExportedAt).getTime() : 0;
      const timeB = b.lastExportedAt ? new Date(b.lastExportedAt).getTime() : 0;
      return timeB - timeA;
    });

    if (!term) {
      return sorted;
    }

    return sorted.filter((project) => {
      const haystack = [project.projectId, project.channelName, project.channelId].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [projects, search]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      {toasts.length > 0 ? (
        <div className="fixed right-4 top-4 z-50 flex w-[min(92vw,360px)] flex-col gap-2">
          {toasts.map((toast) => (
            <div key={toast.id} className={`rounded-xl border px-3 py-2 text-sm shadow-sm ${toastClass(toast.type)}`}>
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Projects Dashboard</h1>
            <p className="mt-1 text-sm text-slate-600">Visualiza todos los exports agrupados por proyecto.</p>
          </div>
          <div className="w-full max-w-xs">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por proyecto/canal"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </div>
        </div>
      </section>

      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-4">
              <div className="h-4 w-2/3 rounded bg-slate-200" />
              <div className="mt-3 h-3 w-1/2 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-1/3 rounded bg-slate-200" />
              <div className="mt-4 h-9 w-full rounded bg-slate-200" />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && filteredProjects.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <h2 className="text-lg font-semibold text-slate-900">No hay proyectos disponibles</h2>
          <p className="mt-2 text-sm text-slate-600">
            Ejecuta un export desde Analyze para generar artifacts en la carpeta <code>exports/</code>.
          </p>
        </section>
      ) : null}

      {!loading && filteredProjects.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredProjects.map((project) => (
            <article key={project.projectId} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{project.channelName ?? project.projectId}</h2>
                  <p className="text-xs text-slate-500">{project.projectId}</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusClasses(project.status)}`}>
                  {project.status}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-600">
                <div>
                  <dt>Último export</dt>
                  <dd className="font-medium text-slate-800">{formatDate(project.lastExportedAt)}</dd>
                </div>
                <div>
                  <dt>Videos</dt>
                  <dd className="font-medium text-slate-800">{project.counts.totalVideosSelected}</dd>
                </div>
                <div>
                  <dt>Warnings</dt>
                  <dd className="font-medium text-slate-800">{project.warningsCount}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd className="truncate font-medium text-slate-800">{project.lastJobId ?? "-"}</dd>
                </div>
              </dl>

              <div className="mt-4 flex items-center justify-between">
                <p className="text-xs text-slate-500">Export v{project.exportVersion ?? "-"}</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void handleExportBundle(project.projectId);
                    }}
                    disabled={bundleStates[project.projectId] === "loading"}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {bundleStates[project.projectId] === "loading" ? (
                      <span className="inline-flex h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                    ) : null}
                    {bundleStates[project.projectId] === "loading"
                      ? "Exportando..."
                      : bundleStates[project.projectId] === "success"
                        ? "Exportado"
                        : bundleStates[project.projectId] === "error"
                          ? "Reintentar"
                          : "Export bundle"}
                  </button>
                  <Link
                    to={`/projects/${encodeURIComponent(project.projectId)}`}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
                  >
                    Abrir proyecto
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
