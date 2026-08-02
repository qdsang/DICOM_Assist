import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, SeriesSelection, ChatMessage, ProviderConfig, LLMService, ViewportContext } from './types';
import {
  buildSelectionSystemPrompt,
  buildSelectionUserPrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  buildFollowUpSystemPrompt,
} from './PromptBuilder';
import { logger } from '../utils/logger';
import i18next from '../i18n';

// --- Shared Helpers ---

type SamplingStrategy = 'every_nth' | 'uniform' | 'all';

function coerceSamplingStrategy(value: unknown): SamplingStrategy {
  if (value === 'every_nth' || value === 'uniform' || value === 'all') return value;
  return 'uniform';
}

/** 检测 claude-sonnet-5 / opus-5 等思考模型(废弃了 temperature) */
function isThinkingModel(model: string): boolean {
  return /claude-(?:sonnet|opus|haiku)-5(?:-|$)/i.test(model);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return text.trim();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function parseSeriesSelection(raw: Record<string, unknown>): SeriesSelection {
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

function populateLegacyFields(selections: SeriesSelection[], reasoning: string, totalImages: number): SelectionPlan {
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
function parseSelectionPlanFromObject(json: Record<string, unknown>): SelectionPlan {
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

function parseSelectionPlan(raw: string): SelectionPlan {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(i18next.t('errors.invalidJson'));
  }
  return parseSelectionPlanFromObject(json);
}

/** 安全降级方案:取主序列中间 50%,uniform 采样 12 张 */
function createSafeDefaultPlan(metadata: StudyMetadata): SelectionPlan {
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

const SELECTION_TOOL = {
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

// --- Claude Service ---

class ClaudeService implements LLMService {
  private apiKey: string;
  private apiUrl: string;
  private model: string;

  constructor(apiKey: string, apiUrl: string, model: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.model = model;
  }

  async getSelectionPlan(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext): Promise<SelectionPlan> {
    const system = buildSelectionSystemPrompt();
    const userContent = buildSelectionUserPrompt(metadata, clinicalHint, viewportContext);

    // Attempt 1: tool use (最可靠,Claude 原生结构化输出)
    try {
      const toolInput = await this.callClaudeWithTool(system, userContent, 1024);
      logger.log('[LLM] Call 1 — tool_use succeeded');
      return parseSelectionPlanFromObject(toolInput);
    } catch (err) {
      logger.warn('[LLM] Call 1 — tool_use failed, falling back to prompt mode:', err);
    }

    // Attempt 2: prompt-based JSON (降级到文本输出 + 正则解析)
    try {
      const text = await this.callClaude({
        system: system + '\n\nIMPORTANT: Output ONLY a valid JSON object, no other text.',
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 1024,
      });
      logger.log('[LLM] Call 1 — prompt fallback succeeded');
      return parseSelectionPlan(text);
    } catch (err) {
      logger.warn('[LLM] Call 1 — prompt fallback failed, using safe default:', err);
    }

    // Attempt 3: safe default
    return createSafeDefaultPlan(metadata);
  }

  async analyzeSlices(
    images: Blob[],
    metadata: StudyMetadata,
    clinicalHint: string,
    plan: SelectionPlan,
    sliceLabels: string[],
    surveyMode?: boolean,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const imageContents = await Promise.all(
      images.map(async (blob, i) => [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/jpeg' as const,
            data: await blobToBase64(blob),
          },
        },
        {
          type: 'text' as const,
          text: sliceLabels[i] ?? `Image ${i + 1}`,
        },
      ]),
    );

    const content = [
      ...imageContents.flat(),
      {
        type: 'text' as const,
        text: buildAnalysisUserPrompt(metadata, clinicalHint, plan, sliceLabels),
      },
    ];

    return this.callClaude({
      system: buildAnalysisSystemPrompt(surveyMode),
      messages: [{ role: 'user', content }],
      maxTokens: 4096,
    }, onDelta);
  }

  async sendFollowUp(conversationHistory: ChatMessage[], metadata: StudyMetadata, onDelta?: (delta: string) => void): Promise<string> {
    const messages = conversationHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    return this.callClaude({
      system: buildFollowUpSystemPrompt() + '\n\nStudy context: ' + metadata.studyDescription,
      messages,
      maxTokens: 4096,
    }, onDelta);
  }

  /** 使用 tool_use 获取结构化选择计划(非流式,响应很短) */
  private async callClaudeWithTool(system: string, userContent: string, maxTokens: number): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
      tools: [SELECTION_TOOL],
      tool_choice: { type: 'tool', name: 'select_slices' },
    };
    if (!isThinkingModel(this.model)) {
      body.temperature = 0;
    }

    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401) throw new Error(i18next.t('errors.invalidApiKey'));
      throw new Error(i18next.t('errors.claudeApiError', { status: res.status, body: errBody }));
    }

    const data = await res.json();
    const toolUse = data.content?.find((b: { type: string }) => b.type === 'tool_use');
    if (!toolUse) throw new Error('No tool_use block in response');
    return toolUse.input as Record<string, unknown>;
  }

  /**
   * 调用 Claude API,支持流式和非流式。
   * 传入 onDelta 时启用 SSE 流式,逐 token 回调;否则等待完整响应。
   */
  private async callClaude(
    params: {
      system: string;
      messages: Array<{ role: string; content: unknown }>;
      maxTokens: number;
    },
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
    };
    if (!isThinkingModel(this.model)) {
      body.temperature = 0;
    }

    // 非流式模式:等待完整响应
    if (!onDelta) {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 401) throw new Error(i18next.t('errors.invalidApiKey'));
        throw new Error(i18next.t('errors.claudeApiError', { status: res.status, body: errBody }));
      }

      const data = await res.json();
      const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
      return textBlock?.text ?? '';
    }

    // 流式模式:解析 SSE,逐 token 回调
    body.stream = true;
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401) throw new Error(i18next.t('errors.invalidApiKey'));
      throw new Error(i18next.t('errors.claudeApiError', { status: res.status, body: errBody }));
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const evt = JSON.parse(jsonStr);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            fullText += evt.delta.text;
            onDelta(evt.delta.text);
          }
        } catch { /* skip malformed SSE line */ }
      }
    }

    return fullText;
  }
}

// --- Ollama Service ---

class OllamaService implements LLMService {
  private baseUrl: string;
  private textModel: string;
  private visionModel: string;

  constructor(textModel: string, visionModel: string, baseUrl: string) {
    this.textModel = textModel;
    this.visionModel = visionModel;
    this.baseUrl = baseUrl;
  }

  async getSelectionPlan(metadata: StudyMetadata, clinicalHint: string, viewportContext?: ViewportContext): Promise<SelectionPlan> {
    try {
      const response = await this.callOllama({
        model: this.textModel,
        system: buildSelectionSystemPrompt(),
        userContent: buildSelectionUserPrompt(metadata, clinicalHint, viewportContext),
      });
      return parseSelectionPlan(response);
    } catch (err) {
      logger.warn('[LLM] Ollama selection plan failed, using safe default:', err);
      return createSafeDefaultPlan(metadata);
    }
  }

  async analyzeSlices(
    images: Blob[],
    metadata: StudyMetadata,
    clinicalHint: string,
    plan: SelectionPlan,
    sliceLabels: string[],
    surveyMode?: boolean,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const base64Images = await Promise.all(images.map(blobToBase64));
    const manifest = sliceLabels.map((l, i) => `  ${i + 1}. ${l}`).join('\n');
    const userContent =
      `IMAGE MANIFEST (${sliceLabels.length} images, in sequential order):\n${manifest}\n\nThe images are provided in the exact order listed above.\n\n` +
      buildAnalysisUserPrompt(metadata, clinicalHint, plan, sliceLabels);

    return this.callOllama({
      model: this.visionModel,
      system: buildAnalysisSystemPrompt(surveyMode),
      userContent,
      images: base64Images,
    }, onDelta);
  }

  async sendFollowUp(conversationHistory: ChatMessage[], metadata: StudyMetadata, onDelta?: (delta: string) => void): Promise<string> {
    const messages = [
      { role: 'system' as const, content: buildFollowUpSystemPrompt() + '\n\nStudy context: ' + metadata.studyDescription },
      ...conversationHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
    ];

    return this.callOllamaRaw({
      model: this.textModel,
      messages,
    }, onDelta);
  }

  /**
   * 调用 Ollama /api/chat,支持流式和非流式。
   * 传入 onDelta 时启用 NDJSON 流式;否则等待完整响应。
   */
  private async callOllama(
    params: {
      model: string;
      system: string;
      userContent: string;
      images?: string[];
    },
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const messages = [
      { role: 'system', content: params.system },
      {
        role: 'user',
        content: params.userContent,
        ...(params.images?.length ? { images: params.images } : {}),
      },
    ];

    return this.callOllamaRaw({ model: params.model, messages }, onDelta);
  }

  /** 底层 Ollama 调用,直接接收 messages 数组 */
  private async callOllamaRaw(
    params: {
      model: string;
      messages: Array<{ role: string; content: string; images?: string[] }>;
    },
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const stream = !!onDelta;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          stream,
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(i18next.t('errors.ollamaTimeout', { model: params.model }));
      }
      throw new Error(i18next.t('errors.ollamaConnect'));
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(i18next.t('errors.ollamaError', { status: res.status, body }));
    }

    // 非流式:解析单个 JSON 响应
    if (!stream) {
      const data = await res.json();
      return data.message?.content ?? '';
    }

    // 流式:解析 NDJSON(每行一个 JSON 对象)
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            fullText += data.message.content;
            onDelta(data.message.content);
          }
        } catch { /* skip malformed line */ }
      }
    }

    return fullText;
  }
}

// --- Factory ---

const DEFAULT_TEXT_MODEL = 'alibayram/medgemma:4b';
const DEFAULT_VISION_MODEL = 'gemma3:4b';

export const DEFAULT_CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

export function createLLMService(config: ProviderConfig): LLMService {
  if (config.provider === 'claude') {
    const key = config.apiKey || import.meta.env.VITE_ANTHROPIC_API_KEY;
    if (!key) throw new Error(i18next.t('errors.claudeKeyRequired'));
    const apiUrl = config.claudeApiUrl || DEFAULT_CLAUDE_API_URL;
    const model = config.claudeModel || DEFAULT_CLAUDE_MODEL;
    return new ClaudeService(key, apiUrl, model);
  }
  const baseUrl = config.ollamaUrl || 'http://localhost:11434';
  const textModel = config.ollamaTextModel || DEFAULT_TEXT_MODEL;
  const visionModel = config.ollamaVisionModel || DEFAULT_VISION_MODEL;
  return new OllamaService(textModel, visionModel, baseUrl);
}

// --- Ollama Management API ---

export interface OllamaModelInfo {
  name: string;
  size: number;
  modified_at: string;
}

export async function fetchOllamaModels(baseUrl = 'http://localhost:11434'): Promise<OllamaModelInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m: { name: string; size: number; modified_at: string }) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
    }));
  } catch {
    return [];
  }
}

export async function pingOllama(baseUrl = 'http://localhost:11434'): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pullOllamaModel(
  modelName: string,
  onProgress: (status: string, percent: number | null) => void,
  baseUrl = 'http://localhost:11434',
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true }),
    });

    if (!res.ok || !res.body) {
      onProgress('Failed to start download', null);
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.error) {
            onProgress(`Error: ${data.error}`, null);
            return false;
          }
          const percent = data.total ? Math.round((data.completed / data.total) * 100) : null;
          onProgress(data.status ?? 'Downloading...', percent);
        } catch { /* skip malformed lines */ }
      }
    }

    onProgress('Complete', 100);
    return true;
  } catch {
    onProgress('Connection failed', null);
    return false;
  }
}
