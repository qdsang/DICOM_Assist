import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, SeriesSelection } from './types';
import { logger } from '../utils/logger';
import i18next from '../i18n';

// --- Types ---

export type SamplingStrategy = 'every_nth' | 'uniform' | 'all';

// --- Helpers ---

export function coerceSamplingStrategy(value: unknown): SamplingStrategy {
  if (value === 'every_nth' || value === 'uniform' || value === 'all') return value;
  return 'uniform';
}

/** 检测 claude-sonnet-5 / opus-5 等思考模型(废弃了 temperature) */
export function isThinkingModel(model: string): boolean {
  return /claude-(?:sonnet|opus|haiku)-5(?:-|$)/i.test(model);
}

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return text.trim();
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- Selection Plan Parsing ---

export function parseSeriesSelection(raw: Record<string, unknown>): SeriesSelection {
  return {
    seriesNumber: String(raw.seriesNumber),
    role: (raw.role as string) === 'supplementary' ? 'supplementary' : 'primary',
    rationale: String(raw.rationale ?? ''),
    sliceRange: [Number((raw.sliceRange as number[])[0]), Number((raw.sliceRange as number[])[1])],
    samplingStrategy: coerceSamplingStrategy(raw.samplingStrategy),
    samplingParam: raw.samplingParam != null ? Number(raw.samplingParam) : undefined,
    windowWidth: Number(raw.windowWidth),
    windowCenter: Number(raw.windowCenter),
  };
}

export function populateLegacyFields(selections: SeriesSelection[], reasoning: string, totalImages: number): SelectionPlan {
  const primary = selections[0];
  return {
    reasoning,
    selections,
    totalImages,
    targetSeries: primary.seriesNumber,
    sliceRange: primary.sliceRange,
    windowCenter: primary.windowCenter,
    windowWidth: primary.windowWidth,
    samplingStrategy: primary.samplingStrategy,
    samplingParam: primary.samplingParam,
  };
}

/** 从已解析的 JSON 对象构建 SelectionPlan(tool_use input 或 JSON.parse 结果共用) */
export function parseSelectionPlanFromObject(json: Record<string, unknown>): SelectionPlan {
  // New multi-series format: { reasoning, selections: [...], totalImages }
  if (Array.isArray(json.selections) && json.selections.length > 0) {
    const selections = (json.selections as Record<string, unknown>[]).map(parseSeriesSelection);
    const reasoning = String(json.reasoning ?? '');
    const totalImages = json.totalImages != null ? Number(json.totalImages) : 0;
    return populateLegacyFields(selections, reasoning, totalImages);
  }

  // Legacy single-series format: { targetSeries, sliceRange, ... }
  if (!json.targetSeries || !json.sliceRange) {
    throw new Error(i18next.t('errors.missingFields'));
  }

  const selection: SeriesSelection = {
    seriesNumber: String(json.targetSeries),
    role: 'primary',
    rationale: String(json.reasoning ?? ''),
    sliceRange: [Number((json.sliceRange as number[])[0]), Number((json.sliceRange as number[])[1])],
    samplingStrategy: coerceSamplingStrategy(json.samplingStrategy),
    samplingParam: json.samplingParam != null ? Number(json.samplingParam) : undefined,
    windowCenter: Number(json.windowCenter),
    windowWidth: Number(json.windowWidth),
  };

  return populateLegacyFields([selection], selection.rationale, 0);
}

export function parseSelectionPlan(raw: string): SelectionPlan {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(i18next.t('errors.invalidJson'));
  }
  return parseSelectionPlanFromObject(json);
}

/** 安全降级方案:取主序列中间 50%,uniform 采样 12 张 */
export function createSafeDefaultPlan(metadata: StudyMetadata): SelectionPlan {
  const primary = metadata.series.find((s) => s.seriesInstanceUID === metadata.primarySeriesUID)
    ?? metadata.series[0];
  if (!primary) throw new Error('No series available for safe default plan');

  const [minInst, maxInst] = primary.instanceNumberRange;
  const total = maxInst - minInst + 1;
  const start = Math.round(minInst + total * 0.25);
  const end = Math.round(minInst + total * 0.75);
  const wc = primary.windowCenter ?? 40;
  const ww = primary.windowWidth ?? 400;

  const selection: SeriesSelection = {
    seriesNumber: String(primary.seriesNumber),
    role: 'primary',
    rationale: 'Fallback: middle 50% of primary series with uniform sampling',
    sliceRange: [start, end],
    samplingStrategy: 'uniform',
    samplingParam: 12,
    windowCenter: wc,
    windowWidth: ww,
  };

  logger.warn('[LLM] Using safe default plan (LLM selection failed)');
  return populateLegacyFields([selection], 'Fallback plan (LLM selection failed)', 12);
}

// --- Tool Schema (Claude function calling) ---

export const SELECTION_TOOL = {
  name: 'select_slices',
  description: 'Select DICOM slices for clinical analysis based on study metadata and the clinical question. You MUST call this tool.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reasoning: {
        type: 'string',
        description: 'Explain why these series, ranges, and windowing were chosen',
      },
      selections: {
        type: 'array',
        description: '1-3 series selections. The first element MUST be the primary series.',
        items: {
          type: 'object',
          properties: {
            seriesNumber: { type: 'string', description: 'Series Number, e.g. "3"' },
            role: { type: 'string', enum: ['primary', 'supplementary'] },
            rationale: { type: 'string', description: 'Why this specific series is included' },
            sliceRange: {
              type: 'array',
              items: { type: 'number' },
              description: '[start, end] inclusive instance number range',
            },
            samplingStrategy: { type: 'string', enum: ['uniform', 'every_nth', 'all'] },
            samplingParam: {
              type: 'number',
              description: 'uniform: exact count to select. every_nth: step size. Omit for "all".',
            },
            windowCenter: { type: 'number' },
            windowWidth: { type: 'number' },
          },
          required: ['seriesNumber', 'role', 'rationale', 'sliceRange', 'samplingStrategy', 'windowCenter', 'windowWidth'],
        },
      },
      totalImages: {
        type: 'number',
        description: 'Total slices across all selections, must be ≤ 20',
      },
    },
    required: ['reasoning', 'selections', 'totalImages'],
  },
};
