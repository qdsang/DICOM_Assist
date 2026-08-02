import type { StudyMetadata } from '../dicom/types';
import type { SelectionPlan, ChatMessage, LLMService, ViewportContext } from './types';
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
  isThinkingModel,
  blobToBase64,
  parseSelectionPlanFromObject,
  parseSelectionPlan,
  createSafeDefaultPlan,
  SELECTION_TOOL,
} from './shared';

export class ClaudeService implements LLMService {
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

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };

    // 非流式模式:等待完整响应
    if (!onDelta) {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
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
      headers,
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
