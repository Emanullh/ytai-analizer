import Collapsible from "../Collapsible";
import KeyValueTable, { KeyValueRow } from "../KeyValueTable";
import Section from "../Section";
import Tooltip from "../Tooltip";
import { asNumber, asRecord, asString } from "../../lib/artifactUtils";

interface ChannelModelViewProps {
  channelModelArtifact: Record<string, unknown> | null;
  debugRawJson?: boolean;
}

const predictorHintByName: Record<string, string> = {
  logDaysSincePublish: "Ajuste por edad del video",
  logDurationSec: "Ajuste por duración",
  isShort: "Efecto short <=60s"
};

function predictorHint(name: string): string {
  if (predictorHintByName[name]) {
    return predictorHintByName[name];
  }
  if (name.startsWith("weekday_")) {
    return "Efecto por día de publicación";
  }
  return "Predictor del modelo baseline";
}

export default function ChannelModelView({ channelModelArtifact, debugRawJson = false }: ChannelModelViewProps) {
  if (!channelModelArtifact) {
    return (
      <Section title="Model">
        <p className="text-sm text-slate-500">No existe artifact channel models para este proyecto.</p>
      </Section>
    );
  }

  const schemaVersion = asString(channelModelArtifact.schemaVersion);
  const model = asRecord(channelModelArtifact.model);
  const fit = asRecord(model?.fit);
  const coefficients = asRecord(model?.coefficients) ?? {};

  const coefficientRows: KeyValueRow[] = Object.entries(coefficients).map(([name, value]) => ({
    key: name,
    label: name,
    value: typeof value === "number" ? value.toFixed(4) : "-",
    hint: predictorHint(name)
  }));

  return (
    <div className="space-y-4">
      <Section title="Baseline Model" hint="Performance normalization de canal">
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Formula</p>
            <p className="mt-1 rounded bg-slate-900/95 px-2 py-1 font-mono text-xs text-slate-100">{asString(model?.formula) ?? "-"}</p>

            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div>
                <p className="text-xs text-slate-500">Type</p>
                <p className="font-medium text-slate-900">{asString(model?.type) ?? "-"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Computed at</p>
                <p className="font-medium text-slate-900">{asString(channelModelArtifact.computedAt) ?? "-"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Timeframe</p>
                <p className="font-medium text-slate-900">{asString(channelModelArtifact.timeframe) ?? "-"}</p>
              </div>
            </div>
          </article>

          <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Fit</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              <li>
                n: <span className="font-semibold text-slate-900">{asNumber(fit?.n) ?? "-"}</span>
              </li>
              <li>
                <Tooltip content="Aprox; no perfecto por robust regression">
                  <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                    r2Approx
                  </span>
                </Tooltip>
                : <span className="font-semibold text-slate-900">{asNumber(fit?.r2Approx)?.toFixed(4) ?? "-"}</span>
              </li>
              <li>
                <Tooltip content="Robust spread; menor = modelo más consistente">
                  <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                    madResidual
                  </span>
                </Tooltip>
                : <span className="font-semibold text-slate-900">{asNumber(fit?.madResidual)?.toFixed(4) ?? "-"}</span>
              </li>
            </ul>
            <div className="mt-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
              <Tooltip content="log_views - predicción; positivo = mejor de lo esperable">
                <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                  residual
                </span>
              </Tooltip>
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
              {(Array.isArray(fit?.notes) ? fit?.notes : []).map((note, index) => (
                <li key={`${note}-${index}`}>{typeof note === "string" ? note : JSON.stringify(note)}</li>
              ))}
            </ul>
          </article>
        </div>
      </Section>

      <Section title="Coeficientes">
        <KeyValueTable rows={coefficientRows} emptyLabel="Sin coeficientes" />
      </Section>

      <Section title="How To Read">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>`residual` positivo sugiere performance mejor a la esperada por baseline.</li>
          <li>Coeficientes positivos empujan `logViews` hacia arriba manteniendo lo demás constante.</li>
          <li>Comparar valores entre videos similares; no usar como causalidad directa.</li>
        </ul>
      </Section>

      {debugRawJson || schemaVersion !== "derived.channel_models.v1" ? (
        <Collapsible title="Raw JSON fallback (debug)">
          <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
            {JSON.stringify(channelModelArtifact, null, 2)}
          </pre>
        </Collapsible>
      ) : null}
    </div>
  );
}
