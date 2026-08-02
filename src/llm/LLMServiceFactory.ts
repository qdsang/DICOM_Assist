/**
 * LLM Service Factory — barrel + factory function.
 *
 * 实现细节拆分到独立模块:
 *   - ClaudeService.ts      Claude API 调用(tool use + 流式 SSE)
 *   - OllamaService.ts      Ollama API 调用(流式 NDJSON)
 *   - shared.ts             共享工具函数 + tool schema + 安全降级
 *   - ollamaManagement.ts   Ollama 模型管理(ping / list / pull)
 *
 * 本文件只负责工厂函数和公共 re-export,消费方无需改动 import 路径。
 */

import type { ProviderConfig, LLMService } from './types';
import { ClaudeService } from './ClaudeService';
import { OllamaService } from './OllamaService';
import i18next from '../i18n';

// Re-export Ollama management API (SettingsPanel 等消费方无需改 import)
export { fetchOllamaModels, pingOllama, pullOllamaModel } from './ollamaManagement';
export type { OllamaModelInfo } from './ollamaManagement';

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
