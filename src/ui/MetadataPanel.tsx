import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { StudyMetadata } from '../dicom/types';

interface MetadataPanelProps {
  metadata: StudyMetadata;
  activeSeriesUID?: string;
  onClose: () => void;
}

function formatDate(dateStr?: string): string {
  if (!dateStr || dateStr.length !== 8) return dateStr ?? '';
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

export default function MetadataPanel({ metadata, activeSeriesUID, onClose }: MetadataPanelProps) {
  const { t } = useTranslation();
  const [studyExpanded, setStudyExpanded] = useState(true);
  const [seriesExpanded, setSeriesExpanded] = useState(true);

  const activeSeries = metadata.series.find((s) => s.seriesInstanceUID === activeSeriesUID)
    ?? metadata.series.find((s) => s.seriesInstanceUID === metadata.primarySeriesUID);

  return (
    <div className="w-72 h-full bg-neutral-900 border-l border-neutral-700 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
        <span className="text-sm font-medium text-neutral-200">{t('metadata.title')}</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto text-xs">
        {/* Study Section */}
        <button
          onClick={() => setStudyExpanded(!studyExpanded)}
          className="flex items-center gap-1 w-full px-3 py-2 text-left text-neutral-300 hover:bg-neutral-800"
        >
          {studyExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="font-medium">{t('metadata.study')}</span>
        </button>
        {studyExpanded && (
          <div className="px-3 pb-2 space-y-1">
            <MetaRow label={t('metadata.description')} value={metadata.studyDescription} />
            <MetaRow label={t('metadata.modality')} value={metadata.modality} />
            <MetaRow label={t('metadata.bodyPart')} value={metadata.bodyPartExamined} />
            <MetaRow label={t('metadata.patientAge')} value={metadata.patientAge} />
            <MetaRow label={t('metadata.patientSex')} value={metadata.patientSex} />
            <MetaRow label={t('metadata.studyDate')} value={formatDate(metadata.studyDate)} />
            <MetaRow label={t('metadata.institution')} value={metadata.institutionName} />
            <MetaRow
              label={t('metadata.scanner')}
              value={[metadata.manufacturer, metadata.manufacturerModelName].filter(Boolean).join(' ') || undefined}
            />
          </div>
        )}

        {/* Active Series Section */}
        {activeSeries && (
          <>
            <button
              onClick={() => setSeriesExpanded(!seriesExpanded)}
              className="flex items-center gap-1 w-full px-3 py-2 text-left text-neutral-300 hover:bg-neutral-800 border-t border-neutral-800"
            >
              {seriesExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <span className="font-medium">{t('metadata.activeSeries')}</span>
            </button>
            {seriesExpanded && (
              <div className="px-3 pb-2">
                <SeriesCard
                  series={activeSeries}
                  isPrimary={activeSeries.seriesInstanceUID === metadata.primarySeriesUID}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="text-neutral-500 shrink-0">{label}</span>
      <span className="text-neutral-300 break-words">{value}</span>
    </div>
  );
}

function SeriesCard({ series, isPrimary }: { series: import('../dicom/types').SeriesMetadata; isPrimary: boolean }) {
  const { t } = useTranslation();
  const plane = series.anatomicalPlane.charAt(0).toUpperCase() + series.anatomicalPlane.slice(1);
  const [instMin, instMax] = series.instanceNumberRange;
  return (
    <div className={`rounded px-2 py-1.5 space-y-0.5 ${isPrimary ? 'bg-blue-950/50 border border-blue-700' : 'bg-neutral-800'}`}>
      <div className="flex items-center gap-1.5 text-neutral-200 font-medium">
        <span>#{series.seriesNumber} {series.seriesDescription || t('common.noDescription')}</span>
        {isPrimary && (
          <span className="text-[10px] font-semibold text-blue-400 bg-blue-900/60 px-1.5 py-0 rounded">{t('metadata.primaryBadge')}</span>
        )}
      </div>
      <div className="text-neutral-400 space-y-0.5">
        <div>{t('metadata.seriesLine', { plane, count: series.slices.length, min: instMin, max: instMax })}</div>
        {series.zCoverageInMm > 0 && (
          <div>{t('metadata.coverage', { value: series.zCoverageInMm.toFixed(1), min: series.zMin.toFixed(1), max: series.zMax.toFixed(1) })}</div>
        )}
        {series.sliceThickness != null && (
          <div>{t('metadata.thickness', { value: series.sliceThickness })}</div>
        )}
        {series.convolutionKernel && (
          <div>{t('metadata.kernel', { value: series.convolutionKernel })}</div>
        )}
        {series.rows != null && series.columns != null && (
          <div>
            {series.pixelSpacing
              ? t('metadata.matrixSpacing', { rows: series.rows, columns: series.columns, spacing: series.pixelSpacing[0].toFixed(2) })
              : t('metadata.matrix', { rows: series.rows, columns: series.columns })}
          </div>
        )}
        {series.estimatedWeighting && (
          <div>
            {series.repetitionTime != null && series.echoTime != null
              ? t('metadata.weightingTRTE', { value: series.estimatedWeighting, tr: Math.round(series.repetitionTime), te: Math.round(series.echoTime) })
              : t('metadata.weighting', { value: series.estimatedWeighting })}
          </div>
        )}
        {series.magneticFieldStrength != null && (
          <div>{t('metadata.field', { value: series.magneticFieldStrength })}</div>
        )}
        {series.kvp != null && (
          <div>
            {series.xrayTubeCurrent != null
              ? t('metadata.kvpMa', { kvp: series.kvp, ma: series.xrayTubeCurrent })
              : t('metadata.kvp', { value: series.kvp })}
          </div>
        )}
        {series.windowCenter != null && series.windowWidth != null && (
          <div>{t('metadata.wl', { w: Math.round(series.windowWidth), c: Math.round(series.windowCenter) })}</div>
        )}
      </div>
    </div>
  );
}
