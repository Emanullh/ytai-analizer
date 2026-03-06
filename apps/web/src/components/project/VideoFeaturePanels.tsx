import type { ReactNode } from "react";
import Badge from "../Badge";
import { asRecord, asString, valueToText } from "../../lib/artifactUtils";
import type { ProjectVideoDetail } from "../../types";

export type VideoFeatureKind = "thumbnail" | "title" | "description" | "transcript";

export interface VideoFeatureActionState {
  running: boolean;
  error: string | null;
  warnings: string[];
}

interface VideoFeaturePanelsProps {
  projectId: string;
  videoId: string;
  detail: ProjectVideoDetail;
  transcriptRows: Array<Record<string, unknown>>;
  transcriptSearch: string;
  onTranscriptSearchChange: (value: string) => void;
  onRerunFeature: (feature: VideoFeatureKind) => void;
  actionStateByFeature: Record<VideoFeatureKind, VideoFeatureActionState>;
  rerunDisabled: boolean;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringList(value: unknown, key?: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (key && item && typeof item === "object") {
        return asString((item as Record<string, unknown>)[key]) ?? "";
      }
      return "";
    })
    .filter(Boolean);
}

function formatMetric(value: number | null, digits = 2): string {
  if (value === null) {
    return "-";
  }
  return value.toFixed(digits);
}

function formatRatio(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function joinOrDash(values: string[], limit = 4): string {
  if (values.length === 0) {
    return "-";
  }
  return values.slice(0, limit).join(", ");
}

function FeatureRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 last:border-b-0">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="max-w-[70%] text-right text-sm text-slate-800">{value}</p>
    </div>
  );
}

function FeatureCard(props: {
  feature: VideoFeatureKind;
  title: string;
  deterministicReady: boolean;
  llmReady: boolean;
  warnings: string[];
  action: VideoFeatureActionState;
  disabled: boolean;
  onRerun: (feature: VideoFeatureKind) => void;
  children: ReactNode;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-900">{props.title}</h4>
            <Badge variant={props.deterministicReady ? "success" : "neutral"}>
              {props.deterministicReady ? "det ok" : "det missing"}
            </Badge>
            <Badge variant={props.llmReady ? "info" : "neutral"}>{props.llmReady ? "llm ok" : "llm missing"}</Badge>
          </div>
          {props.warnings.length > 0 ? (
            <p className="mt-1 text-xs text-amber-700">{props.warnings.length} warning(s) persistidos en el artifact.</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">Feature listo para inspección y rerun individual.</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => props.onRerun(props.feature)}
          disabled={props.disabled}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {props.action.running ? "Procesando..." : `Recalcular ${props.feature}`}
        </button>
      </div>

      <div className="mt-3 space-y-1">{props.children}</div>

      {props.action.error ? (
        <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{props.action.error}</p>
      ) : null}
      {props.action.warnings.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {joinOrDash(props.action.warnings, 2)}
        </div>
      ) : null}
    </article>
  );
}

export default function VideoFeaturePanels(props: VideoFeaturePanelsProps) {
  const derived = asRecord(props.detail.derived);
  const rawVideo = asRecord(props.detail.rawVideo);

  const thumbnailSection = asRecord(derived?.thumbnailFeatures);
  const thumbnailDeterministic = asRecord(thumbnailSection?.deterministic);
  const thumbnailLlm = asRecord(thumbnailSection?.llm);
  const thumbnailWarnings = toStringList(thumbnailSection?.warnings);

  const titleSection = asRecord(derived?.titleFeatures);
  const titleDeterministic = asRecord(titleSection?.deterministic);
  const titleLlm = asRecord(titleSection?.llm);

  const descriptionSection = asRecord(derived?.descriptionFeatures);
  const descriptionDeterministic = asRecord(descriptionSection?.deterministic);
  const descriptionLlm = asRecord(descriptionSection?.llm);
  const descriptionWarnings = toStringList(descriptionSection?.warnings);

  const transcriptSection = asRecord(derived?.transcriptFeatures);
  const transcriptDeterministic = asRecord(transcriptSection?.deterministic);
  const transcriptLlm = asRecord(transcriptSection?.llm);
  const transcriptWarnings = toStringList(transcriptSection?.warnings);

  const thumbnailStyleTags = toStringList(thumbnailLlm?.styleTags, "label");
  const titlePromiseTypes = toStringList(titleLlm?.promise_type, "label");
  const titleCuriosityGaps = toStringList(titleLlm?.curiosity_gap_type, "label");
  const descriptionDomains = Array.isArray(descriptionDeterministic?.domain_counts)
    ? (descriptionDeterministic.domain_counts as Array<Record<string, unknown>>)
        .map((item) => asString(item.domain) ?? "")
        .filter(Boolean)
    : [];
  const descriptionBrands = Array.isArray(descriptionLlm?.sponsorBrandMentions)
    ? (descriptionLlm.sponsorBrandMentions as Array<Record<string, unknown>>)
        .map((item) => asString(item.brand) ?? "")
        .filter(Boolean)
    : [];
  const descriptionLinkPurposes = Array.isArray(descriptionLlm?.linkPurpose)
    ? (descriptionLlm.linkPurpose as Array<Record<string, unknown>>)
        .map((item) => asString(item.label) ?? "")
        .filter(Boolean)
    : [];
  const transcriptStoryArc = asString(asRecord(transcriptLlm?.story_arc)?.label);
  const transcriptCtas = Array.isArray(transcriptLlm?.cta_segments)
    ? (transcriptLlm.cta_segments as Array<Record<string, unknown>>)
        .map((item) => asString(item.type) ?? "")
        .filter(Boolean)
    : [];
  const transcriptSponsors = Array.isArray(transcriptLlm?.sponsor_segments)
    ? (transcriptLlm.sponsor_segments as Array<Record<string, unknown>>)
        .map((item) => asString(item.brand) ?? "")
        .filter(Boolean)
    : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white p-4">
          <img
            src={`/api/projects/${encodeURIComponent(props.projectId)}/thumb/${encodeURIComponent(props.videoId)}`}
            alt={asString(rawVideo?.title) ?? props.videoId}
            className="h-44 w-full rounded-xl object-cover"
          />
          <div className="mt-4 space-y-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Video</p>
              <p className="text-base font-semibold text-slate-900">{asString(rawVideo?.title) ?? props.videoId}</p>
              <p className="font-mono text-xs text-slate-500">{props.videoId}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={thumbnailDeterministic ? "success" : "neutral"}>
                OCR {thumbnailDeterministic ? "ready" : "missing"}
              </Badge>
              <Badge variant={transcriptDeterministic ? "success" : "warning"}>
                Transcript {props.detail.transcriptJsonl ? "loaded" : "missing"}
              </Badge>
            </div>
            <FeatureRow label="Publicado" value={asString(rawVideo?.publishedAt) ?? "-"} />
            <FeatureRow label="Duración" value={valueToText(rawVideo?.durationSec)} />
            <FeatureRow label="Idioma" value={asString(rawVideo?.defaultLanguage) ?? asString(rawVideo?.defaultAudioLanguage) ?? "auto"} />
            <FeatureRow label="Descripción" value={asString(rawVideo?.description)?.slice(0, 120) ?? "-"} />
          </div>
        </article>

        <div className="grid gap-4 md:grid-cols-2">
          <FeatureCard
            feature="thumbnail"
            title="Thumbnail"
            deterministicReady={Boolean(thumbnailDeterministic)}
            llmReady={Boolean(thumbnailLlm)}
            warnings={thumbnailWarnings}
            action={props.actionStateByFeature.thumbnail}
            disabled={props.rerunDisabled}
            onRerun={props.onRerunFeature}
          >
            <FeatureRow label="OCR text" value={asString(thumbnailDeterministic?.ocrText) ?? "-"} />
            <FeatureRow label="Hi-conf words" value={valueToText(thumbnailDeterministic?.ocrWordCountHiConf)} />
            <FeatureRow label="Text area" value={formatRatio(toNumber(thumbnailDeterministic?.textAreaRatio))} />
            <FeatureRow label="Big text" value={valueToText(thumbnailDeterministic?.hasBigText)} />
            <FeatureRow label="Archetype" value={asString(asRecord(thumbnailLlm?.archetype)?.label) ?? "-"} />
            <FeatureRow label="Clutter" value={asString(asRecord(thumbnailLlm?.clutterLevel)?.label) ?? "-"} />
            <FeatureRow label="Style tags" value={joinOrDash(thumbnailStyleTags)} />
          </FeatureCard>

          <FeatureCard
            feature="title"
            title="Title"
            deterministicReady={Boolean(titleDeterministic)}
            llmReady={Boolean(titleLlm)}
            warnings={props.actionStateByFeature.title.warnings}
            action={props.actionStateByFeature.title}
            disabled={props.rerunDisabled}
            onRerun={props.onRerunFeature}
          >
            <FeatureRow label="Words" value={valueToText(titleDeterministic?.title_len_words)} />
            <FeatureRow label="Caps ratio" value={formatRatio(toNumber(titleDeterministic?.caps_ratio))} />
            <FeatureRow label="Has number" value={valueToText(titleDeterministic?.has_number)} />
            <FeatureRow label="Coverage" value={formatRatio(toNumber(titleDeterministic?.title_keyword_coverage))} />
            <FeatureRow
              label="Early 30s"
              value={formatRatio(toNumber(titleDeterministic?.title_keyword_early_coverage_30s))}
            />
            <FeatureRow label="Promise type" value={joinOrDash(titlePromiseTypes)} />
            <FeatureRow label="Curiosity gap" value={joinOrDash(titleCuriosityGaps)} />
            <FeatureRow
              label="Claim strength"
              value={asString(asRecord(titleLlm?.headline_claim_strength)?.label) ?? "-"}
            />
          </FeatureCard>

          <FeatureCard
            feature="description"
            title="Description"
            deterministicReady={Boolean(descriptionDeterministic)}
            llmReady={Boolean(descriptionLlm)}
            warnings={descriptionWarnings}
            action={props.actionStateByFeature.description}
            disabled={props.rerunDisabled}
            onRerun={props.onRerunFeature}
          >
            <FeatureRow label="Words" value={valueToText(descriptionDeterministic?.desc_len_words)} />
            <FeatureRow label="URLs" value={valueToText(descriptionDeterministic?.url_count)} />
            <FeatureRow label="Top domains" value={joinOrDash(descriptionDomains)} />
            <FeatureRow label="Sponsor disclosure" value={valueToText(descriptionDeterministic?.has_sponsor_disclosure)} />
            <FeatureRow label="Affiliate disclosure" value={valueToText(descriptionDeterministic?.has_affiliate_disclosure)} />
            <FeatureRow label="Primary CTA" value={asString(asRecord(descriptionLlm?.primaryCTA)?.label) ?? "-"} />
            <FeatureRow label="Sponsor brands" value={joinOrDash(descriptionBrands)} />
            <FeatureRow label="Link purpose" value={joinOrDash(descriptionLinkPurposes)} />
          </FeatureCard>

          <FeatureCard
            feature="transcript"
            title="Transcript"
            deterministicReady={Boolean(transcriptDeterministic)}
            llmReady={Boolean(transcriptLlm)}
            warnings={transcriptWarnings}
            action={props.actionStateByFeature.transcript}
            disabled={props.rerunDisabled}
            onRerun={props.onRerunFeature}
          >
            <FeatureRow
              label="Title coverage"
              value={formatRatio(toNumber(transcriptDeterministic?.title_keyword_coverage))}
            />
            <FeatureRow
              label="Delivery 30s"
              value={formatMetric(toNumber(transcriptDeterministic?.promise_delivery_30s_score), 3)}
            />
            <FeatureRow label="WPM overall" value={formatMetric(toNumber(transcriptDeterministic?.wpm_overall), 1)} />
            <FeatureRow label="Topic shifts" value={valueToText(transcriptDeterministic?.topic_shift_count)} />
            <FeatureRow label="Story arc" value={transcriptStoryArc ?? "-"} />
            <FeatureRow label="CTA segments" value={joinOrDash(transcriptCtas)} />
            <FeatureRow label="Sponsor segments" value={joinOrDash(transcriptSponsors)} />
          </FeatureCard>
        </div>
      </div>

      <article className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Transcript segments</h4>
            <p className="text-xs text-slate-500">Inspección rápida del input que usan `title` y `transcript`.</p>
          </div>
          <input
            type="text"
            value={props.transcriptSearch}
            onChange={(event) => props.onTranscriptSearchChange(event.target.value)}
            placeholder="Buscar en transcript"
            className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100 sm:w-64"
          />
        </div>
        {props.detail.transcriptJsonl == null ? (
          <p className="text-sm text-slate-500">No transcript disponible.</p>
        ) : (
          <pre className="max-h-[32vh] overflow-auto rounded-xl border border-slate-200 bg-slate-950/95 p-3 text-xs text-slate-100">
            {JSON.stringify(props.transcriptRows, null, 2)}
          </pre>
        )}
      </article>
    </div>
  );
}
