import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';
import type { SliceMapping } from '../llm/useLLMChat';

// Matches: "Slice 45/187", "Slices 45-66/187", "Slice 45", "Slices 45–66"
// Also matches with optional "Series #N" prefix: "Series #3 Slice 45/187"
// Also matches legacy "Image N" format as fallback
const SLICE_REF_PATTERN = /(?:Series\s*#?(\d+)\s+)?\b[Ss]lices?\s+(\d+)(?:\s*[-–]\s*(\d+))?(?:\/(\d+))?\b/g;
const IMAGE_REF_PATTERN = /\b[Ii]mages?\s+(\d+)(?:\s*[-–]\s*(\d+))?\b/g;

interface ParsedSegment {
  type: 'text' | 'slice-ref';
  content: string;
  fromInstance?: number;
  toInstance?: number;
  total?: number;
  /** Explicit "Series #N" captured by regex */
  seriesNumber?: string;
  isLegacyImageRef?: boolean;
  /** Character index of this segment in the original line (for context lookup) */
  sourceIndex?: number;
}

function parseSliceRefs(text: string): ParsedSegment[] {
  // Collect all matches from both patterns with their positions
  const allMatches: { index: number; length: number; from: number; to: number; total?: number; seriesNumber?: string; content: string; isLegacy: boolean }[] = [];

  for (const match of text.matchAll(SLICE_REF_PATTERN)) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      from: parseInt(match[2], 10),
      to: match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10),
      total: match[4] ? parseInt(match[4], 10) : undefined,
      seriesNumber: match[1] ?? undefined,
      content: match[0],
      isLegacy: false,
    });
  }

  for (const match of text.matchAll(IMAGE_REF_PATTERN)) {
    // Only add if not overlapping with a slice ref
    const overlaps = allMatches.some(
      (m) => match.index < m.index + m.length && match.index + match[0].length > m.index,
    );
    if (!overlaps) {
      allMatches.push({
        index: match.index,
        length: match[0].length,
        from: parseInt(match[1], 10),
        to: match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10),
        content: match[0],
        isLegacy: true,
      });
    }
  }

  // Sort by position
  allMatches.sort((a, b) => a.index - b.index);

  const segments: ParsedSegment[] = [];
  let lastIndex = 0;

  for (const match of allMatches) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'slice-ref',
      content: match.content,
      fromInstance: match.from,
      toInstance: match.to,
      total: match.total,
      seriesNumber: match.seriesNumber,
      isLegacyImageRef: match.isLegacy,
      sourceIndex: match.index,
    });
    lastIndex = match.index + match.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

/**
 * Build a lookup structure that maps keywords found in slice mapping labels
 * to their series numbers. Used to infer which series the LLM is referencing
 * from surrounding text context (e.g. "sagittal" → series "8").
 */
interface SeriesKeyword {
  keyword: string;     // lowercase search term
  seriesNumber: string;
}

function buildSeriesKeywords(sliceMappings: SliceMapping[]): SeriesKeyword[] {
  // Collect unique series with a representative label for each
  const seriesSeen = new Map<string, string>(); // seriesNumber → label
  for (const m of sliceMappings) {
    if (!seriesSeen.has(m.seriesNumber)) {
      seriesSeen.set(m.seriesNumber, m.label);
    }
  }

  const keywords: SeriesKeyword[] = [];
  for (const [seriesNumber, label] of seriesSeen) {
    // Extract the series description part (before " — Slice")
    const descPart = label.split(' — ')[0] ?? label;

    // Add the full description as a keyword
    if (descPart.length > 2) {
      keywords.push({ keyword: descPart.toLowerCase(), seriesNumber });
    }

    // Add individual meaningful words from the description (skip very short ones)
    for (const word of descPart.split(/[\s_]+/)) {
      const lower = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (lower.length < 3) continue;
      // Skip very generic words
      if (['the', 'and', 'for', 'drb', 'with', 'from'].includes(lower)) continue;
      keywords.push({ keyword: lower, seriesNumber });
    }

    // Add anatomical plane keywords based on common naming conventions
    const descLower = descPart.toLowerCase();
    if (/\bsag\b|sagittal/i.test(descLower)) {
      keywords.push({ keyword: 'sagittal', seriesNumber });
      keywords.push({ keyword: 'sag', seriesNumber });
    }
    if (/\bcor\b|coronal/i.test(descLower)) {
      keywords.push({ keyword: 'coronal', seriesNumber });
      keywords.push({ keyword: 'cor', seriesNumber });
    }
    if (/\bax\b|axial|tra\b|transverse/i.test(descLower)) {
      keywords.push({ keyword: 'axial', seriesNumber });
      keywords.push({ keyword: 'transverse', seriesNumber });
    }

    // Add the series number itself
    keywords.push({ keyword: `series #${seriesNumber}`, seriesNumber });
    keywords.push({ keyword: `series ${seriesNumber}`, seriesNumber });
  }

  // Sort longer keywords first so more specific matches win
  keywords.sort((a, b) => b.keyword.length - a.keyword.length);

  return keywords;
}

/**
 * Given surrounding text context and the keyword lookup, infer which series
 * is being referenced. Looks at the text within ~120 chars before the slice
 * reference (same sentence / nearby context).
 */
function inferSeriesFromContext(
  fullLineText: string,
  refIndex: number,
  seriesKeywords: SeriesKeyword[],
): string | undefined {
  // Look at a window of text before (and a bit after) the slice reference
  const contextStart = Math.max(0, refIndex - 120);
  const contextEnd = Math.min(fullLineText.length, refIndex + 20);
  const context = fullLineText.slice(contextStart, contextEnd).toLowerCase();

  for (const { keyword, seriesNumber } of seriesKeywords) {
    if (context.includes(keyword)) {
      return seriesNumber;
    }
  }
  return undefined;
}

export default function AssistantMessage({
  content,
  sliceMappings,
  onNavigate,
}: {
  content: string;
  sliceMappings: SliceMapping[];
  onNavigate: (mapping: SliceMapping) => void;
}) {
  // Build keyword lookup once from the available slice mappings
  const seriesKeywords = useMemo(
    () => buildSeriesKeywords(sliceMappings),
    [sliceMappings],
  );

  const handleSliceClick = useCallback((fromInstance: number, toInstance: number, isLegacy: boolean, seriesNumber?: string) => {
    let mapping: SliceMapping | undefined;

    // Filter to the referenced series when available
    const candidates = seriesNumber
      ? sliceMappings.filter((m) => m.seriesNumber === seriesNumber)
      : sliceMappings;
    // Fall back to all mappings if series filter yields nothing
    const pool = candidates.length > 0 ? candidates : sliceMappings;

    if (isLegacy) {
      // Legacy "Image N" — fromInstance/toInstance are 1-based image indices
      const midImage = Math.round((fromInstance + toInstance) / 2);
      mapping = pool.find((m) => m.imageIndex === midImage)
        ?? pool.find((m) => m.imageIndex >= fromInstance && m.imageIndex <= toInstance);
    } else {
      // New "Slice X/Y" — fromInstance/toInstance are actual instance numbers
      const midInstance = Math.round((fromInstance + toInstance) / 2);
      // Find closest mapping to midInstance within range
      mapping = pool.reduce<SliceMapping | undefined>((best, m) => {
        if (m.instanceNumber < fromInstance || m.instanceNumber > toInstance) return best;
        if (!best) return m;
        return Math.abs(m.instanceNumber - midInstance) < Math.abs(best.instanceNumber - midInstance) ? m : best;
      }, undefined);
      // If no exact range match, find the nearest slice in the pool
      if (!mapping) {
        mapping = pool.reduce<SliceMapping | undefined>((best, m) => {
          if (!best) return m;
          return Math.abs(m.instanceNumber - midInstance) < Math.abs(best.instanceNumber - midInstance) ? m : best;
        }, undefined);
      }
    }

    if (mapping) {
      onNavigate(mapping);
    }
  }, [sliceMappings, onNavigate]);

  const lines = content.split('\n');

  return (
    <div className="mt-1 text-sm text-neutral-200 space-y-0.5">
      {lines.map((line, i) => (
        <FormattedLine
          key={i}
          line={line}
          sliceMappings={sliceMappings}
          seriesKeywords={seriesKeywords}
          onSliceClick={handleSliceClick}
        />
      ))}
    </div>
  );
}

function FormattedLine({
  line,
  sliceMappings,
  seriesKeywords,
  onSliceClick,
}: {
  line: string;
  sliceMappings: SliceMapping[];
  seriesKeywords: SeriesKeyword[];
  onSliceClick: (from: number, to: number, isLegacy: boolean, seriesNumber?: string) => void;
}) {
  // Empty line
  if (line.trim() === '') {
    return <div className="h-1.5" />;
  }

  // Headers: ## or **Header:**
  if (line.startsWith('## ')) {
    return (
      <h3 className="text-xs font-semibold text-blue-400 uppercase tracking-wide mt-3 mb-1 border-b border-neutral-800 pb-1">
        {line.slice(3)}
      </h3>
    );
  }

  // ### subheader
  if (line.startsWith('### ')) {
    return (
      <h4 className="text-xs font-semibold text-neutral-100 mt-2.5 mb-0.5">
        {line.slice(4)}
      </h4>
    );
  }

  // Bold-only lines (section titles like **Overall Impression:**)
  const boldLineMatch = line.match(/^\*\*(.+?)\*\*:?\s*$/);
  if (boldLineMatch) {
    return (
      <p className="font-semibold text-neutral-100 mt-2.5 mb-0.5">{boldLineMatch[1]}</p>
    );
  }

  // Bullet points
  const bulletMatch = line.match(/^(\s*)[-•*]\s+(.*)/);
  if (bulletMatch) {
    const indent = bulletMatch[1].length > 0;
    return (
      <div className={`flex gap-1.5 ${indent ? 'ml-4' : 'ml-1'} my-0.5`}>
        <span className="text-neutral-600 shrink-0 mt-0.5">&#x2022;</span>
        <span className="text-neutral-300">
          <InlineContent text={bulletMatch[2]} fullLineText={line} sliceMappings={sliceMappings} seriesKeywords={seriesKeywords} onSliceClick={onSliceClick} />
        </span>
      </div>
    );
  }

  // Numbered list
  const numberedMatch = line.match(/^(\d+)\.\s+(.*)/);
  if (numberedMatch) {
    return (
      <div className="flex gap-2 ml-1 my-0.5">
        <span className="text-blue-400 shrink-0 text-xs font-medium mt-0.5">{numberedMatch[1]}.</span>
        <span className="text-neutral-300">
          <InlineContent text={numberedMatch[2]} fullLineText={line} sliceMappings={sliceMappings} seriesKeywords={seriesKeywords} onSliceClick={onSliceClick} />
        </span>
      </div>
    );
  }

  // Regular paragraph
  return (
    <p className="text-neutral-300 my-0.5">
      <InlineContent text={line} fullLineText={line} sliceMappings={sliceMappings} seriesKeywords={seriesKeywords} onSliceClick={onSliceClick} />
    </p>
  );
}

function InlineContent({
  text,
  fullLineText,
  sliceMappings,
  seriesKeywords,
  onSliceClick,
}: {
  text: string;
  fullLineText: string;
  sliceMappings: SliceMapping[];
  seriesKeywords: SeriesKeyword[];
  onSliceClick: (from: number, to: number, isLegacy: boolean, seriesNumber?: string) => void;
}) {
  const { t } = useTranslation();
  const segments = parseSliceRefs(text);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'slice-ref' && seg.fromInstance != null && seg.toInstance != null) {
          const isLegacy = seg.isLegacyImageRef ?? false;

          // Resolve series: explicit "Series #N" > context-inferred > undefined (use all)
          let resolvedSeries = seg.seriesNumber;
          if (!resolvedSeries && seg.sourceIndex != null) {
            resolvedSeries = inferSeriesFromContext(fullLineText, seg.sourceIndex, seriesKeywords);
          }

          // Check if we have a mapping for this reference
          const hasMapping = isLegacy
            ? sliceMappings.some((m) => m.imageIndex >= seg.fromInstance! && m.imageIndex <= seg.toInstance!)
            : sliceMappings.some((m) => m.instanceNumber >= seg.fromInstance! && m.instanceNumber <= seg.toInstance!)
              || sliceMappings.length > 0; // For slice refs, always show as clickable if we have any mappings (will navigate to nearest)
          if (hasMapping) {
            return (
              <button
                key={i}
                onClick={() => onSliceClick(seg.fromInstance!, seg.toInstance!, isLegacy, resolvedSeries)}
                className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded bg-blue-900/40 border border-blue-700/50 text-blue-300 hover:bg-blue-800/50 hover:text-blue-200 transition-colors text-xs font-medium mx-0.5 cursor-pointer"
                title={resolvedSeries ? t('chat.goToSliceWithSeries', { content: seg.content, series: resolvedSeries }) : t('chat.goToSlice', { content: seg.content })}
              >
                <Eye className="w-3 h-3" />
                {seg.content}
              </button>
            );
          }
        }
        // Handle inline bold: **text**
        return <BoldText key={i} text={seg.content} />;
      })}
    </>
  );
}

function BoldText({ text }: { text: string }) {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="text-neutral-100 font-semibold">{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
