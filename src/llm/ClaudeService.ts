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
import type { ToolExecutor, ToolResultContent } from './agentTypes';
import { AGENT_TOOLS, DEFAULT_AGENT_CONFIG } from './agentTypes';
import { buildAgentSystemPrompt } from './agentTools';

export class ClaudeService implements LLMService {
  private apiKey: string;
  private apiUrl: string;
  private model: string;
  private readonly maxRetries = 3;

  constructor(apiKey: string, apiUrl: string, model: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.model = model;
  }

  /** 判断错误是否可重试(网络错误 / 5xx 代理错误 / 超时) */
  private isRetryableError(err: unknown, res?: Response): boolean {
    // HTTP 5xx 响应(502 代理错误、503 服务不可用、504 网关超时、529 过载)
    if (res && res.status >= 500 && res.status < 600) return true;
    // 网络层错误(ECONNRESET、超时、连接拒绝等)— fetch 抛出而非返回响应
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (err instanceof DOMException && err.name === 'TimeoutError') return true;
      if (msg.includes('econnreset') || msg.includes('fetch') || msg.includes('network')
        || msg.includes('timeout') || msg.includes('socket')) return true;
      // i18next 包装的 Claude API 错误(包含状态码)
      if (msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('529')) return true;
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 带重试的 fetch:针对网络错误和 5xx 响应自动重试,指数退避(1s/2s/4s)。
   * 对流式响应同样适用——502 发生在 fetch 返回时,stream 尚未开始读取。
   */
  private async fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, options);
        if (this.isRetryableError(null, res) && attempt < this.maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          logger.warn(`[Claude] HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
          await this.sleep(delay);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (this.isRetryableError(err) && attempt < this.maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          logger.warn(`[Claude] Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries}):`, err instanceof Error ? err.message : err);
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
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

  // --- Agentic Loop (tool_use 循环) ---

  async runAgentAnalysis(
    initialImages: Blob[],
    metadata: StudyMetadata,
    clinicalHint: string,
    sliceLabels: string[],
    toolExecutor: ToolExecutor,
    onDelta?: (delta: string) => void,
    onToolCall?: (name: string, input: Record<string, unknown>) => void,
    shouldStop?: () => boolean,
  ): Promise<string> {
    const system = buildAgentSystemPrompt();

    // 构建初始消息:图片 + 临床问题
    const imageContents = await Promise.all(
      initialImages.map(async (blob, i) => [
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

    const initialContent = [
      ...imageContents.flat(),
      {
        type: 'text' as const,
        text: `Study: ${metadata.studyDescription} (${metadata.modality})\n` +
          `Series available: ${metadata.series.length}\n` +
          `Clinical question: ${clinicalHint}\n\n` +
          `These are initial slices for your review. Use list_series() and the other tools to investigate further, then call finish_analysis with your report.`,
      },
    ];

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: initialContent },
    ];

    // 累积所有 LLM 文本输出(思考过程 + 已有发现)——中断/达上限时作为部分结果返回,
    // 避免丢失已分析内容导致后续 follow-up "白分析"
    let accumulatedText = '';

    for (let iter = 0; iter < DEFAULT_AGENT_CONFIG.maxIterations; iter++) {
      // 检查是否已被用户中止
      if (shouldStop?.()) {
        logger.log('[Agent] Stopped by user at iter', iter);
        return accumulatedText + (accumulatedText ? '\n\n' : '') +
          '⏹️ 分析已中止。以上为已获取的信息,可在下方继续提问以补全分析。';
      }

      const response = await this.callClaudeWithTools({
        system,
        messages,
        tools: AGENT_TOOLS,
        maxTokens: 4096,
      });

      // 累积 + 转发文本块到 onDelta(让用户看到 LLM 的思考过程)
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          const text = block.text as string;
          accumulatedText += text;
          onDelta?.(text);
        }
      }

      // 没有工具调用 → 分析结束,返回最终文本
      if (response.stop_reason !== 'tool_use') {
        return accumulatedText || 'Analysis complete.';
      }

      // 处理工具调用
      const toolResults: unknown[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        const toolName = block.name as string;
        const toolInput = block.input as Record<string, unknown>;
        const toolUseId = block.id as string;

        // 中止检查(在执行工具前)
        if (shouldStop?.()) {
          logger.log('[Agent] Stopped by user before tool', toolName);
          return accumulatedText + (accumulatedText ? '\n\n' : '') +
            '⏹️ 分析已中止。以上为已获取的信息,可在下方继续提问以补全分析。';
        }

        onToolCall?.(toolName, toolInput);
        logger.log(`[Agent] iter ${iter} tool: ${toolName}`, toolInput);

        // finish_analysis → 返回报告(报告替代思考过程作为最终输出)
        if (toolName === 'finish_analysis') {
          return String(toolInput.report ?? '');
        }

        // 执行工具
        const result = await toolExecutor.execute(toolName, toolInput);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: this.toolResultToContent(result),
        });
      }

      // 添加 assistant 回复和工具结果到消息历史
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // 达到上限:返回已累积的内容 + 提示(而非丢弃)
    logger.warn('[Agent] Max iterations reached, returning accumulated text');
    return accumulatedText + (accumulatedText ? '\n\n' : '') +
      '⚠️ 已达到工具调用次数上限。以上为已获取的信息,可在下方继续提问以补全分析。';
  }

  /** 将 ToolResultContent 转为 Claude API content 格式 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toolResultToContent(result: ToolResultContent): any {
    switch (result.type) {
      case 'text':
        return [{ type: 'text', text: result.text }];
      case 'image':
        return [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: result.base64 } }];
      case 'images':
        return [
          ...result.images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 },
          })),
          { type: 'text', text: result.text },
        ];
    }
  }

  /** 带 tools 的 Claude API 调用(非流式,需要完整响应来处理 tool_use) */
  private async callClaudeWithTools(params: {
    system: string;
    messages: Array<{ role: string; content: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: any[];
    maxTokens: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<{ content: any[]; stop_reason: string }> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
    };
    if (!isThinkingModel(this.model)) {
      body.temperature = 0;
    }

    const res = await this.fetchWithRetry(this.apiUrl, {
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
    return {
      content: data.content ?? [],
      stop_reason: data.stop_reason ?? 'end_turn',
    };
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

    const res = await this.fetchWithRetry(this.apiUrl, {
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
      const res = await this.fetchWithRetry(this.apiUrl, {
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
    const res = await this.fetchWithRetry(this.apiUrl, {
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
