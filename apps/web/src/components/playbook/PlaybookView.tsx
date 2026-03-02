import Badge from "../Badge";
import Section from "../Section";
import Tooltip from "../Tooltip";
import Collapsible from "../Collapsible";
import { asNumber, asRecord, asRecordArray, asString, asStringArray, valueToText } from "../../lib/artifactUtils";

interface PlaybookViewProps {
  playbook: Record<string, unknown> | null;
  onEvidenceFieldClick?: (fieldPath: string, supportedBy: string[]) => void;
  debugRawJson?: boolean;
}

function confidenceVariant(value: number | null): "neutral" | "success" | "warning" {
  if (value === null) {
    return "neutral";
  }
  if (value >= 0.75) {
    return "success";
  }
  if (value >= 0.45) {
    return "warning";
  }
  return "neutral";
}

function toConfidence(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric === null) {
    return null;
  }
  if (numeric > 1 && numeric <= 100) {
    return numeric / 100;
  }
  return Math.max(0, Math.min(1, numeric));
}

function evidenceButtons(
  evidenceFields: string[],
  supportedBy: string[],
  onEvidenceFieldClick?: (fieldPath: string, supportedBy: string[]) => void
) {
  if (evidenceFields.length === 0) {
    return <span className="text-xs text-slate-500">-</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {evidenceFields.map((fieldPath) => (
        <button
          key={fieldPath}
          type="button"
          className="rounded-md border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-slate-50"
          onClick={() => onEvidenceFieldClick?.(fieldPath, supportedBy)}
        >
          {fieldPath}
        </button>
      ))}
    </div>
  );
}

function supportChips(supportedBy: string[]) {
  if (supportedBy.length === 0) {
    return <span className="text-xs text-slate-500">-</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {supportedBy.map((videoId) => (
        <code key={videoId} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
          {videoId}
        </code>
      ))}
    </div>
  );
}

function renderInsightTable(args: {
  title: string;
  items: Record<string, unknown>[];
  onEvidenceFieldClick?: (fieldPath: string, supportedBy: string[]) => void;
}) {
  return (
    <Section title={args.title}>
      {args.items.length === 0 ? <p className="text-sm text-slate-500">Sin elementos.</p> : null}
      {args.items.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Summary</th>
                <th className="px-3 py-2">
                  <Tooltip content="0..1, basado en fuerza de evidencia (n/cohorts/drivers)">
                    <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                      Confidence
                    </span>
                  </Tooltip>
                </th>
                <th className="px-3 py-2">Supported by</th>
                <th className="px-3 py-2">
                  <Tooltip content="Paths de features que respaldan el insight">
                    <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                      Evidence fields
                    </span>
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {args.items.map((item, index) => {
                const title = asString(item.title) ?? asString(item.name) ?? asString(item.id) ?? `item-${index + 1}`;
                const summary = asString(item.summary) ?? asString(item.description) ?? "-";
                const confidence = toConfidence(item.confidence);
                const supportedBy = asStringArray(item.supported_by);
                const evidenceFields = asStringArray(item.evidence_fields);

                return (
                  <tr key={`${title}-${index}`}>
                    <td className="px-3 py-2 font-medium text-slate-900">{title}</td>
                    <td className="px-3 py-2 text-slate-700">{summary}</td>
                    <td className="px-3 py-2">
                      <Badge variant={confidenceVariant(confidence)}>{confidence === null ? "-" : confidence.toFixed(2)}</Badge>
                    </td>
                    <td className="px-3 py-2">{supportChips(supportedBy)}</td>
                    <td className="px-3 py-2">{evidenceButtons(evidenceFields, supportedBy, args.onEvidenceFieldClick)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}

export default function PlaybookView({ playbook, onEvidenceFieldClick, debugRawJson = false }: PlaybookViewProps) {
  if (!playbook) {
    return (
      <Section title="Playbook">
        <p className="text-sm text-slate-500">No existe artifact playbook para este proyecto.</p>
      </Section>
    );
  }

  const channel = asRecord(playbook.channel);
  const positioning = asRecord(playbook.positioning);
  const oneLine = asString(positioning?.oneLine) ?? asString(playbook.oneLine);
  const audience = asStringArray(positioning?.audience ?? positioning?.audiences ?? playbook.audience);
  const valueProps = asStringArray(positioning?.valueProps ?? playbook.valueProps);
  const contentPillars = asRecordArray(playbook.contentPillars ?? playbook.pillars);

  const insights = asRecordArray(playbook.insights);
  const rules = asRecordArray(playbook.rules);
  const keys = asRecordArray(playbook.keys);
  const antiPatterns = asRecordArray(playbook.antiPatterns ?? playbook.anti_patterns);

  const checklistsRecord = asRecord(playbook.checklists);
  const checklistTitle = asStringArray(checklistsRecord?.title);
  const checklistThumb = asStringArray(checklistsRecord?.thumbnail);
  const checklistHook = asStringArray(checklistsRecord?.hook_0_30s ?? checklistsRecord?.hook030);

  const evidence = asRecord(playbook.evidence);
  const evidenceCohorts = asRecordArray(evidence?.cohorts);
  const evidenceDrivers = asRecordArray(evidence?.drivers);
  const exemplars = asRecord(evidence?.exemplars);
  const schemaVersion = asString(playbook.schemaVersion);

  return (
    <div className="space-y-4">
      <Section title="Playbook Header" hint="Identidad del artifact generado">
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-slate-500">Channel</p>
            <p className="font-medium text-slate-900">{asString(channel?.channelName) ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-500">Timeframe</p>
            <p className="font-medium text-slate-900">{asString(channel?.timeframe) ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-500">Job ID</p>
            <p className="font-mono text-xs text-slate-800">{asString(channel?.jobId) ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-500">Generated at</p>
            <p className="font-medium text-slate-900">{asString(playbook.generatedAt) ?? "-"}</p>
          </div>
        </div>
      </Section>

      <Section title="Positioning">
        <div className="space-y-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">One line</p>
            <p className="font-medium text-slate-900">{oneLine ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Audience</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {audience.length === 0 ? <span className="text-slate-500">-</span> : null}
              {audience.map((value) => (
                <Badge key={value}>{value}</Badge>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Value props</p>
            {valueProps.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-slate-700">
                {valueProps.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-500">-</p>
            )}
          </div>
        </div>
      </Section>

      <Section title="Content Pillars">
        {contentPillars.length === 0 ? <p className="text-sm text-slate-500">Sin pillars.</p> : null}
        {contentPillars.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {contentPillars.map((pillar, index) => {
              const title = asString(pillar.pillar) ?? asString(pillar.title) ?? asString(pillar.name) ?? `pillar-${index + 1}`;
              const description = asString(pillar.description) ?? "-";
              const supportedBy = asStringArray(pillar.supported_by);
              return (
                <article key={`${title}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="font-semibold text-slate-900">
                    <Tooltip content="Cluster temático extraído del canal">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        {title}
                      </span>
                    </Tooltip>
                  </p>
                  <p className="mt-1 text-sm text-slate-700">{description}</p>
                  <div className="mt-2">
                    <Tooltip content="Lista de videos que sustentan el pillar (videoId)">
                      <span tabIndex={0} className="text-xs font-medium text-slate-500">
                        Supported by
                      </span>
                    </Tooltip>
                    <div className="mt-1">{supportChips(supportedBy)}</div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </Section>

      {renderInsightTable({ title: "Insights", items: insights, onEvidenceFieldClick })}
      {renderInsightTable({ title: "Rules", items: rules, onEvidenceFieldClick })}
      {renderInsightTable({ title: "Keys", items: keys, onEvidenceFieldClick })}

      <Section title="Anti-patterns">
        {antiPatterns.length === 0 ? <p className="text-sm text-slate-500">Sin anti-patterns.</p> : null}
        {antiPatterns.length > 0 ? (
          <ul className="space-y-2">
            {antiPatterns.map((item, index) => {
              const title = asString(item.title) ?? asString(item.name) ?? `anti-pattern-${index + 1}`;
              const supportedBy = asStringArray(item.supported_by);
              const evidenceFields = asStringArray(item.evidence_fields);
              return (
                <li key={`${title}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="font-medium text-slate-900">{title}</p>
                  <div className="mt-1 text-xs text-slate-600">{supportChips(supportedBy)}</div>
                  <div className="mt-2">{evidenceButtons(evidenceFields, supportedBy, onEvidenceFieldClick)}</div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

      <Section title="Checklists">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Title</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {checklistTitle.length === 0 ? <li>-</li> : null}
              {checklistTitle.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Thumbnail</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {checklistThumb.length === 0 ? <li>-</li> : null}
              {checklistThumb.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Hook 0-30s</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {checklistHook.length === 0 ? <li>-</li> : null}
              {checklistHook.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section title="Evidence Explorer" hint="MVP: cohorts/drivers/exemplars del artifact">
        <div className="space-y-3">
          <Collapsible title={`Cohorts (${evidenceCohorts.length})`}>
            {evidenceCohorts.length === 0 ? <p className="text-sm text-slate-500">Sin cohorts.</p> : null}
            {evidenceCohorts.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Dimension</th>
                      <th className="px-3 py-2">Bucket</th>
                      <th className="px-3 py-2">n</th>
                      <th className="px-3 py-2">medianResidual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {evidenceCohorts.map((cohort, index) => (
                      <tr key={`cohort-${index}`}>
                        <td className="px-3 py-2">{valueToText(cohort.dimension)}</td>
                        <td className="px-3 py-2">{valueToText(cohort.bucket)}</td>
                        <td className="px-3 py-2">{valueToText(cohort.n)}</td>
                        <td className="px-3 py-2">{valueToText(cohort.medianResidual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Collapsible>

          <Collapsible title={`Drivers (${evidenceDrivers.length})`}>
            {evidenceDrivers.length === 0 ? <p className="text-sm text-slate-500">Sin drivers.</p> : null}
            {evidenceDrivers.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Feature</th>
                      <th className="px-3 py-2">
                        <Tooltip content="Magnitud correlacional/delta; no implica causalidad">
                          <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                            Effect
                          </span>
                        </Tooltip>
                      </th>
                      <th className="px-3 py-2">
                        <Tooltip content="Tamaño de muestra dentro del subset exportado">
                          <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                            n
                          </span>
                        </Tooltip>
                      </th>
                      <th className="px-3 py-2">Supported by</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {evidenceDrivers.map((driver, index) => {
                      const feature = asString(driver.feature) ?? `driver-${index + 1}`;
                      const effect =
                        asNumber(driver.absEffect) ?? asNumber(driver.deltaMedianResidual) ?? asNumber(driver.rho) ?? asNumber(driver.effect);
                      const n = asNumber(driver.n) ?? asNumber(driver.nCategory);
                      const supportedBy = asStringArray(driver.supported_by);
                      return (
                        <tr key={`${feature}-${index}`}>
                          <td className="px-3 py-2">{feature}</td>
                          <td className="px-3 py-2">{effect == null ? "-" : effect.toFixed(3)}</td>
                          <td className="px-3 py-2">{n == null ? "-" : n}</td>
                          <td className="px-3 py-2">{supportChips(supportedBy)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Collapsible>

          <Collapsible title="Exemplars">
            {!exemplars ? <p className="text-sm text-slate-500">Sin exemplars.</p> : null}
            {exemplars ? (
              <pre className="max-h-60 overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
                {JSON.stringify(exemplars, null, 2)}
              </pre>
            ) : null}
          </Collapsible>
        </div>
      </Section>

      {debugRawJson || schemaVersion !== "analysis.playbook.v1" ? (
        <Collapsible title="Raw JSON fallback (debug)">
          <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
            {JSON.stringify(playbook, null, 2)}
          </pre>
        </Collapsible>
      ) : null}
    </div>
  );
}
