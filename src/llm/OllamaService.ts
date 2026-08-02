import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, ChatMessage, LLMService, ViewportContext } from './types';
import type { ToolExecutor } from './agentTypes';
import {
  buildSelectionSystemPrompt,
  buildSelectionUserPrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  buildFollowUpSystemPrompt,
} from './PromptBuilder';
import { logger } from '../utils/logger';
import i18next from '../i18n';
import {
  blobToBase64,
  parseSelectionPlan,
  createSafeDefaultPlan,
} from './shared';

export class OllamaService implements LLMService {
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

  // --- Agentic Loop (Ollama 不支持 tool_use,降级到一次性分析) ---

  async runAgentAnalysis(
    initialImages: Blob[],
    metadata: StudyMetadata,
    clinicalHint: string,
    sliceLabels: string[],
    _toolExecutor: ToolExecutor,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    logger.warn('[Agent] Ollama does not support agentic loop, falling back to one-shot analysis');
    const fallbackPlan: SelectionPlan = {
      reasoning: 'N/A (Ollama fallback)',
      selections: [],
      totalImages: initialImages.length,
      targetSeries: '',
      sliceRange: [0, 0],
      windowCenter: 40,
      windowWidth: 400,
      samplingStrategy: 'uniform',
    };
    return this.analyzeSlices(initialImages, metadata, clinicalHint, fallbackPlan, sliceLabels, false, onDelta);
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
