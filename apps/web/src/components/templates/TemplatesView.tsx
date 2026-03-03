import Badge from "../Badge";
import Collapsible from "../Collapsible";
import CopyablePrompt from "../CopyablePrompt";
import Section from "../Section";
import SectionExplainer from "../SectionExplainer";
import Tooltip from "../Tooltip";
import { asRecord, asRecordArray, asString, asStringArray } from "../../lib/artifactUtils";

interface TemplatesViewProps {
  templates: Record<string, unknown> | null;
  onEvidenceFieldClick?: (fieldPath: string, supportedBy: string[]) => void;
  debugRawJson?: boolean;
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

function parsePipelineTemplate(raw: string): Array<{ label: string; instruction: string }> {
  const segments = raw.split("|").map((s) => s.trim()).filter(Boolean);
  return segments.map((segment) => {
    const colonIdx = segment.indexOf(":");
    if (colonIdx > 0) {
      return { label: segment.slice(0, colonIdx).trim(), instruction: segment.slice(colonIdx + 1).trim() };
    }
    return { label: "block", instruction: segment };
  });
}

function renderTimelineCard(template: Record<string, unknown>) {
  const timeline = asRecord(template.timeline);
  const templateStr = asString(template.template);

  if (timeline) {
    const merged = { ...template, ...timeline };
    const slots = [
      { key: "0-10", label: "0-10" },
      { key: "10-30", label: "10-30" },
      { key: "30-120", label: "30-120" },
      { key: "mid", label: "mid" },
      { key: "end", label: "end" },
    ];
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {slots.map((slot) => {
          const value =
            asString(merged[slot.key]) ??
            asString(merged[slot.key.replace("-", "_")]) ??
            asString(merged[`block_${slot.key}`]) ??
            "-";
          return (
            <div key={slot.key} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <p className="text-xs font-semibold uppercase text-slate-500">{slot.label}</p>
              <p className="mt-1 text-sm text-slate-700">{value}</p>
            </div>
          );
        })}
      </div>
    );
  }

  if (templateStr && templateStr.includes("|")) {
    const parsed = parsePipelineTemplate(templateStr);
    const colsClass =
      parsed.length >= 5
        ? "lg:grid-cols-5"
        : parsed.length === 4
          ? "lg:grid-cols-4"
          : parsed.length === 3
            ? "lg:grid-cols-3"
            : "lg:grid-cols-2";
    return (
      <div className={`grid gap-2 sm:grid-cols-2 ${colsClass}`}>
        {parsed.map((slot, idx) => (
          <div key={`${slot.label}-${idx}`} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
            <p className="text-xs font-semibold uppercase text-slate-500">{slot.label}</p>
            <p className="mt-1 text-sm text-slate-700">{slot.instruction}</p>
          </div>
        ))}
      </div>
    );
  }

  if (templateStr) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm text-slate-700">{templateStr}</p>
      </div>
    );
  }

  return <p className="text-sm text-slate-500">-</p>;
}

export default function TemplatesView({ templates, onEvidenceFieldClick, debugRawJson = false }: TemplatesViewProps) {
  if (!templates) {
    return (
      <Section title="Templates">
        <p className="text-sm text-slate-500">No existe artifact templates para este proyecto.</p>
      </Section>
    );
  }

  const titleTemplates = asRecordArray(templates.titleTemplates);
  const thumbnailTemplates = asRecordArray(templates.thumbnailTemplates);
  const scriptTemplates = asRecordArray(templates.scriptTemplates);
  const schemaVersion = asString(templates.schemaVersion);

  const titleGenPrompt = asRecord(templates.titleGenerationPrompt);
  const titleGenSystemPrompt = asString(titleGenPrompt?.systemPrompt);
  const titleGenSupportedBy = asStringArray(titleGenPrompt?.supported_by);
  const titleGenExamples = Array.isArray(titleGenPrompt?.exampleInputOutput)
    ? (titleGenPrompt.exampleInputOutput as Array<Record<string, unknown>>)
    : [];

  const scriptGenPrompt = asRecord(templates.scriptGenerationPrompt);
  const scriptGenSystemPrompt = asString(scriptGenPrompt?.systemPrompt);
  const scriptGenSupportedBy = asStringArray(scriptGenPrompt?.supported_by);

  return (
    <div className="space-y-4">
      <Section title="Title Templates" hint="Patrones de títulos por contexto de uso">
        {titleTemplates.length > 0 ? (
          <SectionExplainer>
            <strong>{titleTemplates.length} fórmulas de título</strong> extraídas de los videos de mejor rendimiento.
            Incluyen reglas generales y plantillas con variables que puedes adaptar a nuevos temas.
          </SectionExplainer>
        ) : null}
        {titleTemplates.length === 0 ? <p className="text-sm text-slate-500">Sin title templates.</p> : null}
        {titleTemplates.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {titleTemplates.map((template, index) => {
              const templateText = asString(template.template) ?? asString(template.title) ?? `template-${index + 1}`;
              const whenToUse = asString(template.when_to_use) ?? asString(template.whenToUse) ?? "-";
              const supportedBy = asStringArray(template.supported_by);
              const evidenceFields = asStringArray(template.evidence_fields);
              return (
                <article key={`${templateText}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    <Tooltip content="Patrón de título recomendado">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        Template
                      </span>
                    </Tooltip>
                  </p>
                  <p className="mt-1 rounded bg-slate-900/95 px-2 py-1 font-mono text-xs text-slate-100">{templateText}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    <Tooltip content="Condición basada en features/residual/cohorts">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        when_to_use
                      </span>
                    </Tooltip>
                  </p>
                  <p className="mt-1 text-sm text-slate-700">{whenToUse}</p>
                  <div className="mt-2">{supportChips(supportedBy)}</div>
                  <div className="mt-2">{evidenceButtons(evidenceFields, supportedBy, onEvidenceFieldClick)}</div>
                </article>
              );
            })}
          </div>
        ) : null}
      </Section>

      <Section title="Thumbnail Templates" hint="Arquetipos visuales y reglas de diseño">
        {thumbnailTemplates.length > 0 ? (
          <SectionExplainer>
            <strong>{thumbnailTemplates.length} arquetipos de thumbnail</strong>: reglas de diseño y estilos visuales
            respaldados por datos de rendimiento. Usa la evidencia para validar cada patrón.
          </SectionExplainer>
        ) : null}
        {thumbnailTemplates.length === 0 ? <p className="text-sm text-slate-500">Sin thumbnail templates.</p> : null}
        {thumbnailTemplates.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {thumbnailTemplates.map((template, index) => {
              const label =
                asString(template.label) ??
                asString(template.name) ??
                asString(template.when_to_use) ??
                asString(template.whenToUse) ??
                `thumbnail-${index + 1}`;
              const archetype = asString(template.archetype);
              const designBrief =
                asString(template.designBrief) ??
                asString(template.design_brief) ??
                asString(template.template) ??
                "-";
              const supportedBy = asStringArray(template.supported_by);
              const evidenceFields = asStringArray(template.evidence_fields);

              return (
                <article key={`${label}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{label}</p>
                    {archetype ? <Badge>{archetype}</Badge> : null}
                  </div>
                  <p className="mt-2 text-sm text-slate-700">{designBrief}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    <Tooltip content="Revisa textAreaRatio/face presence si aparecen en evidence_fields para validar patrón visual">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        Visual evidence hints
                      </span>
                    </Tooltip>
                  </p>
                  <div className="mt-2">{supportChips(supportedBy)}</div>
                  <div className="mt-2">{evidenceButtons(evidenceFields, supportedBy, onEvidenceFieldClick)}</div>
                </article>
              );
            })}
          </div>
        ) : null}
      </Section>

      <Section title="Script Templates" hint="Blueprint por bloques temporales">
        {scriptTemplates.length > 0 ? (
          <SectionExplainer>
            <strong>{scriptTemplates.length} blueprints de guión</strong> con estructura temporal (0-10s, 10-30s, 30-120s,
            mid, end). Adaptados del estilo narrativo de los mejores videos del canal.
          </SectionExplainer>
        ) : null}
        {scriptTemplates.length === 0 ? <p className="text-sm text-slate-500">Sin script templates.</p> : null}
        {scriptTemplates.length > 0 ? (
          <div className="space-y-3">
            {scriptTemplates.map((template, index) => {
              const title = asString(template.title) ?? asString(template.name) ?? `script-${index + 1}`;
              const supportedBy = asStringArray(template.supported_by);
              const evidenceFields = asStringArray(template.evidence_fields);
              return (
                <article key={`${title}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="font-semibold text-slate-900">{title}</p>
                  <div className="mt-2">{renderTimelineCard(template)}</div>
                  <p className="mt-2 text-xs text-slate-500">
                    <Tooltip content="Ejemplos que sustentan este blueprint temporal">
                      <span tabIndex={0} className="cursor-help rounded-sm border-b border-dotted border-slate-400 focus:outline-none">
                        supported_by
                      </span>
                    </Tooltip>
                  </p>
                  <div className="mt-1">{supportChips(supportedBy)}</div>
                  <div className="mt-2">{evidenceButtons(evidenceFields, supportedBy, onEvidenceFieldClick)}</div>
                </article>
              );
            })}
          </div>
        ) : null}
      </Section>

      {titleGenSystemPrompt ? (
        <Section title="Title Generation Prompt" hint="Prompt para generar títulos con cualquier LLM">
          <SectionExplainer>
            Usa este prompt como system prompt en cualquier LLM para generar títulos de video siguiendo el estilo
            y patrones del canal. Proporciona un tema como input para obtener variantes de título.
          </SectionExplainer>
          <CopyablePrompt
            title="Prompt de generación de títulos"
            content={titleGenSystemPrompt}
            supportedBy={titleGenSupportedBy}
          />
          {titleGenExamples.length > 0 ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">Ejemplos Input → Output</p>
              <div className="mt-2 space-y-1">
                {titleGenExamples.map((ex, idx) => (
                  <div key={idx} className="flex gap-2 text-xs">
                    <span className="font-medium text-slate-600">Topic:</span>
                    <span className="text-slate-700">{asString(ex.topic) ?? "-"}</span>
                    <span className="font-medium text-slate-600">→</span>
                    <span className="font-semibold text-slate-900">{asString(ex.generatedTitle) ?? "-"}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Section>
      ) : null}

      {scriptGenSystemPrompt ? (
        <Section title="Script Generation Prompt" hint="Prompt para generar guiones con cualquier LLM">
          <SectionExplainer>
            Usa este prompt como system prompt para generar guiones de video completos en el estilo del canal.
            Incluye reglas de ritmo, estructura narrativa y técnicas de hook derivadas del análisis.
          </SectionExplainer>
          <CopyablePrompt
            title="Prompt de generación de guiones"
            content={scriptGenSystemPrompt}
            supportedBy={scriptGenSupportedBy}
          />
        </Section>
      ) : null}

      {debugRawJson || schemaVersion !== "derived.templates.v1" ? (
        <Collapsible title="Raw JSON fallback (debug)">
          <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
            {JSON.stringify(templates, null, 2)}
          </pre>
        </Collapsible>
      ) : null}
    </div>
  );
}
