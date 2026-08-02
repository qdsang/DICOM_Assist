import { useState, useRef, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Send, Trash2, AlertCircle, Loader2, ClipboardList, MessageSquare, MapPin } from 'lucide-react';
import type { ChatMessage, SelectionPlan } from '../llm/types';
import type { StudyMetadata } from '../dicom/types';
import type { ChatStatus, PipelineState, SliceMapping } from '../llm/useLLMChat';
import { detectBodyPart, getChecklist, buildSurveyHint } from '../llm/anatomyChecklists';
import PipelineView from './PipelineView';
import AssistantMessage from './AssistantMessage';
import PlanPreviewCard from './PlanPreviewCard';

export interface ChatSidebarHandle {
  focusInput: () => void;
}

interface ChatSidebarProps {
  messages: ChatMessage[];
  status: ChatStatus;
  statusText: string;
  error: string | null;
  pipeline: PipelineState | null;
  currentPlan: SelectionPlan | null;
  studyMetadata: StudyMetadata | null;
  onConfirmPlan: (plan: SelectionPlan) => void;
  onCancelPlan: () => void;
  onStartAnalysis: (hint: string, options?: { surveyMode?: boolean }) => void;
  onSendFollowUp: (text: string) => void;
  onClear: () => void;
  onClearAnnotations: () => void;
  onClose: () => void;
  onNavigateToSlice: (mapping: SliceMapping) => void;
  annotationCount?: number;
}

export default forwardRef<ChatSidebarHandle, ChatSidebarProps>(function ChatSidebar({
  messages,
  status,
  statusText,
  error,
  pipeline,
  currentPlan,
  studyMetadata,
  onConfirmPlan,
  onCancelPlan,
  onStartAnalysis,
  onSendFollowUp,
  onClear,
  onClearAnnotations,
  onClose,
  onNavigateToSlice,
  annotationCount = 0,
}, ref) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [surveyActive, setSurveyActive] = useState(false);
  const [selectedStructures, setSelectedStructures] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status !== 'idle' && status !== 'error' && status !== 'awaiting-confirmation';

  const detectedBodyPart = useMemo(
    () => (studyMetadata ? detectBodyPart(studyMetadata) : 'unknown'),
    [studyMetadata],
  );
  const checklist = useMemo(() => getChecklist(detectedBodyPart), [detectedBodyPart]);

  // Initialize selected structures from defaults when checklist changes
  useEffect(() => {
    setSelectedStructures(
      new Set(checklist.structures.filter((s) => s.defaultChecked).map((s) => s.id)),
    );
  }, [checklist]);

  // Reset survey state when chat is cleared
  useEffect(() => {
    if (messages.length === 0) {
      setSurveyActive(false);
    }
  }, [messages.length]);

  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
  }));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status, pipeline, currentPlan]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;

    if (messages.length === 0) {
      // No conversation yet — start a new analysis
      onStartAnalysis(trimmed);
    } else {
      // Existing conversation — send as follow-up
      onSendFollowUp(trimmed);
    }
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="w-96 h-full bg-neutral-900 border-l border-neutral-700 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700 shrink-0">
        <span className="text-sm font-medium text-neutral-200">{t('chat.title')}</span>
        <div className="flex items-center gap-1">
          {annotationCount > 0 && (
            <button
              onClick={onClearAnnotations}
              title={t('chat.clearAnnotations', { defaultValue: 'Clear annotations ({count})', count: annotationCount })}
              className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-neutral-700 text-amber-400 hover:text-amber-300 text-xs"
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>{annotationCount}</span>
            </button>
          )}
          {messages.length > 0 && (
            <button
              onClick={onClear}
              title={t('chat.clearChat')}
              className="p-1 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !busy && !pipeline && (
          studyMetadata ? (
            <SurveyModePanel
              surveyActive={surveyActive}
              onToggleSurvey={setSurveyActive}
              checklist={checklist}
              selectedStructures={selectedStructures}
              onToggleStructure={(id) => {
                setSelectedStructures((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              onRunSurvey={() => {
                const ids = Array.from(selectedStructures);
                const hint = buildSurveyHint(detectedBodyPart, ids);
                onStartAnalysis(hint, { surveyMode: true });
              }}
            />
          ) : (
            <div className="text-center text-neutral-500 text-xs mt-8">
              <p>{t('chat.noAnalysis')}</p>
              <p className="mt-1">{t('chat.describeToStart')}</p>
            </div>
          )
        )}

        {messages.map((msg, i) => {
          const isFirstUser = msg.role === 'user' && i === 0;
          const showPipeline = isFirstUser && pipeline;
          return (
            <div key={msg.id}>
              <MessageBubble message={msg} />
              {showPipeline && <PipelineView pipeline={pipeline} />}
              {msg.role === 'assistant' && (
                <AssistantMessage
                  content={msg.content}
                  sliceMappings={pipeline?.sliceMappings ?? []}
                  onNavigate={onNavigateToSlice}
                />
              )}
            </div>
          );
        })}

        {/* Plan preview card — inline, only during awaiting-confirmation */}
        {status === 'awaiting-confirmation' && currentPlan && studyMetadata && (
          <PlanPreviewCard
            plan={currentPlan}
            metadata={studyMetadata}
            onAccept={onConfirmPlan}
            onCancel={onCancelPlan}
          />
        )}

        {busy && statusText && status === 'following-up' && (
          <div className="flex items-center gap-2 text-xs text-blue-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            {statusText}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mb-2 px-3 py-2 bg-red-950/50 border border-red-800 rounded text-xs text-red-300 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Disclaimer */}
      <div className="px-3 py-1 text-[10px] text-neutral-600 text-center shrink-0">
        {t('chat.notForClinical')}
      </div>

      {/* Input */}
      <div className="px-3 pb-3 pt-1 border-t border-neutral-800 shrink-0">
        <div className="flex items-center gap-2 bg-neutral-800 rounded-lg px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={messages.length > 0 ? t('chat.askFollowUp') : t('chat.describeContext')}
            disabled={busy}
            className="flex-1 bg-transparent text-sm text-neutral-100 placeholder-neutral-500 outline-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={busy || !input.trim()}
            className="p-1 rounded text-neutral-400 hover:text-blue-400 disabled:opacity-30 disabled:hover:text-neutral-400"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
});

interface SurveyModePanelProps {
  surveyActive: boolean;
  onToggleSurvey: (active: boolean) => void;
  checklist: ReturnType<typeof getChecklist>;
  selectedStructures: Set<string>;
  onToggleStructure: (id: string) => void;
  onRunSurvey: () => void;
}

function SurveyModePanel({
  surveyActive,
  onToggleSurvey,
  checklist,
  selectedStructures,
  onToggleStructure,
  onRunSurvey,
}: SurveyModePanelProps) {
  const { t } = useTranslation();
  const selectedCount = selectedStructures.size;

  return (
    <div className="mt-4 space-y-3">
      {/* Mode toggle */}
      <div className="flex gap-1 bg-neutral-800 rounded-lg p-1">
        <button
          onClick={() => onToggleSurvey(false)}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            !surveyActive
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:text-neutral-300'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          {t('chat.freeText')}
        </button>
        <button
          onClick={() => onToggleSurvey(true)}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            surveyActive
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:text-neutral-300'
          }`}
        >
          <ClipboardList className="w-3.5 h-3.5" />
          {t('chat.guidedSurvey')}
        </button>
      </div>

      {!surveyActive && (
        <div className="text-center text-neutral-500 text-xs">
          <p>{t('chat.describeToStart')}</p>
        </div>
      )}

      {surveyActive && (
        <div className="space-y-2">
          <div className="text-xs text-neutral-400">
            {t('chat.detected')} <span className="text-neutral-200 font-medium">{checklist.displayName}</span>
          </div>

          {/* Structure checklist */}
          <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
            {checklist.structures.map((item) => (
              <label
                key={item.id}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-800 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedStructures.has(item.id)}
                  onChange={() => onToggleStructure(item.id)}
                  className="rounded border-neutral-600 bg-neutral-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                />
                <span className="text-xs text-neutral-300">{item.label}</span>
              </label>
            ))}
          </div>

          {/* Run button */}
          <button
            onClick={onRunSurvey}
            disabled={selectedCount === 0}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium transition-colors"
          >
            {t('chat.runSurvey', { count: selectedCount })}
          </button>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-blue-600 text-white text-sm px-3 py-2 rounded-xl rounded-br-sm">
          {message.content}
        </div>
      </div>
    );
  }
  // Assistant messages are rendered by AssistantMessage
  return null;
}
