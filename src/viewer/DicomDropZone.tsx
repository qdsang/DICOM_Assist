import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, FolderOpen, FlaskConical, Loader2 } from 'lucide-react';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';
import type { AnatomicalPlane } from '../dicom/orientationUtils';
import { extractFileMetadata, buildStudyMetadata, type RawFileRecord } from '../dicom/MetadataExtractor';
import type { StudyMetadata } from '../dicom/types';
import { loadSampleData, type SampleDataProgress } from '../utils/sampleDataLoader';

export interface LoadResult {
  imageIds: string[];
  primaryAxis: AnatomicalPlane;
  studyMetadata: StudyMetadata;
}

interface DicomDropZoneProps {
  onFilesLoaded: (result: LoadResult) => void;
}

function isDicomFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.dcm') || !name.includes('.');
}

function hasDicomPreamble(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 132) return false;
  const view = new Uint8Array(buffer, 128, 4);
  return view[0] === 0x44 && view[1] === 0x49 && view[2] === 0x43 && view[3] === 0x4d; // "DICM"
}

async function getAllFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const files: File[] = [];
  const entries: FileSystemEntry[] = [];

  for (let i = 0; i < dataTransfer.items.length; i++) {
    const entry = dataTransfer.items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  async function readEntry(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve)
      );
      if (isDicomFile(file)) files.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const subEntries: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve)
        );
        subEntries.push(...batch);
      } while (batch.length > 0);
      for (const sub of subEntries) {
        await readEntry(sub);
      }
    }
  }

  if (entries.length > 0) {
    for (const entry of entries) {
      await readEntry(entry);
    }
  } else {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];
      if (isDicomFile(file)) files.push(file);
    }
  }

  return files;
}

const PARSE_BATCH_SIZE = 20;

export default function DicomDropZone({ onFilesLoaded }: DicomDropZoneProps) {
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<'reading' | 'sorting'>('reading');
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [sampleProgress, setSampleProgress] = useState<SampleDataProgress | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        setLoading(false);
        return;
      }

      setLoadingPhase('reading');
      setProgress({ loaded: 0, total: files.length });

      // Parse headers to extract metadata, then register with fileManager
      const parsed: { file: File; meta: Omit<RawFileRecord, 'imageId'> }[] = [];

      for (let start = 0; start < files.length; start += PARSE_BATCH_SIZE) {
        const batch = files.slice(start, start + PARSE_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (file) => {
            try {
              let dataSet: dicomParser.DataSet;
              try {
                const partial = await file.slice(0, 131072).arrayBuffer();
                if (!file.name.toLowerCase().endsWith('.dcm') && !hasDicomPreamble(partial)) {
                  return null; // Skip non-DICOM files without .dcm extension
                }
                dataSet = dicomParser.parseDicom(new Uint8Array(partial), { untilTag: 'x7fe00010' });
              } catch {
                // Partial read failed (e.g., large private tags) — retry with full file
                const full = await file.arrayBuffer();
                if (!file.name.toLowerCase().endsWith('.dcm') && !hasDicomPreamble(full)) {
                  return null;
                }
                dataSet = dicomParser.parseDicom(new Uint8Array(full), { untilTag: 'x7fe00010' });
              }

              const meta = extractFileMetadata(dataSet);
              return { file, meta };
            } catch {
              return {
                file,
                meta: {
                  instanceNumber: 0,
                  zPosition: 0,
                  imagePositionPatient: [0, 0, 0] as [number, number, number],
                  imageOrientationPatient: [1, 0, 0, 0, 1, 0] as [number, number, number, number, number, number],
                  seriesInstanceUID: 'unknown',
                  seriesNumber: 0,
                  seriesDescription: '',
                  modality: 'unknown',
                  studyDescription: '',
                },
              };
            }
          })
        );
        for (const r of results) {
          if (r) parsed.push(r);
        }
        setProgress({ loaded: Math.min(start + PARSE_BATCH_SIZE, files.length), total: files.length });
      }

      setLoadingPhase('sorting');

      // Register files with fileManager and assign imageIds
      const records: RawFileRecord[] = parsed.map((p) => {
        const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(p.file);
        return { ...p.meta, imageId };
      });

      const studyMetadata = buildStudyMetadata(records);

      const primarySeries = studyMetadata.series.find(
        (s) => s.seriesInstanceUID === studyMetadata.primarySeriesUID
      );
      const imageIds = primarySeries ? primarySeries.slices.map((s) => s.imageId) : records.map((r) => r.imageId);
      const detectedPlane = primarySeries?.anatomicalPlane;
      const primaryAxis: AnatomicalPlane =
        detectedPlane === 'axial' || detectedPlane === 'sagittal' || detectedPlane === 'coronal'
          ? detectedPlane
          : 'axial';

      setLoading(false);
      onFilesLoaded({ imageIds, primaryAxis, studyMetadata });
    },
    [onFilesLoaded]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      setLoading(true);

      const files = await getAllFiles(e.dataTransfer);
      await processFiles(files);
    },
    [processFiles]
  );

  const handleInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;

      setLoading(true);

      const files: File[] = [];
      for (let i = 0; i < fileList.length; i++) {
        if (isDicomFile(fileList[i])) files.push(fileList[i]);
      }
      await processFiles(files);

      // Reset input so the same folder can be re-selected
      if (inputRef.current) inputRef.current.value = '';
    },
    [processFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleLoadSample = useCallback(async () => {
    setSampleError(null);
    setSampleProgress({ phase: 'downloading', percent: 0 });
    try {
      const files = await loadSampleData((p) => setSampleProgress(p));
      setLoading(true);
      setSampleProgress(null);
      await processFiles(files);
    } catch (err) {
      setSampleProgress(null);
      setSampleError(err instanceof Error ? err.message : t('dropzone.loadFailed'));
    }
  }, [processFiles]);

  if (loading) {
    const pct = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-neutral-400 text-sm">
          {loadingPhase === 'reading'
            ? t('dropzone.readingHeaders', { loaded: progress.loaded, total: progress.total })
            : t('dropzone.sortingSlices')}
        </p>
        <div className="w-64 h-2 bg-neutral-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-100"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  const sampleBusy = sampleProgress != null;
  const sampleLabel = sampleProgress
    ? sampleProgress.phase === 'downloading'
      ? t('dropzone.downloading', { percent: sampleProgress.percent })
      : sampleProgress.phase === 'extracting'
        ? t('dropzone.extracting', { percent: sampleProgress.percent })
        : t('dropzone.loadingIntoViewer')
    : null;

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={`flex flex-col items-center justify-center h-full border-2 border-dashed rounded-lg transition-colors ${
        dragOver ? 'border-blue-500 bg-blue-500/10' : 'border-neutral-700 hover:border-neutral-500'
      }`}
    >
      <Upload className="w-12 h-12 text-neutral-500 mb-3" />
      <p className="text-neutral-400 text-lg">{t('dropzone.dropHere')}</p>
      <p className="text-neutral-600 text-sm mt-1">{t('dropzone.dropHint')}</p>
      <input
        ref={inputRef}
        type="file"
        // @ts-expect-error webkitdirectory is a non-standard attribute
        webkitdirectory=""
        multiple
        hidden
        onChange={handleInputChange}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={sampleBusy}
        className="mt-3 flex items-center gap-2 px-4 py-2 rounded-md bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 transition-colors text-sm disabled:opacity-50"
      >
        <FolderOpen className="w-4 h-4" />
        {t('dropzone.browseFolder')}
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 w-48 mt-4 mb-2">
        <div className="flex-1 h-px bg-neutral-700" />
        <span className="text-xs text-neutral-600">{t('dropzone.or')}</span>
        <div className="flex-1 h-px bg-neutral-700" />
      </div>

      {/* Sample data button */}
      <button
        type="button"
        onClick={handleLoadSample}
        disabled={sampleBusy}
        className="flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30 hover:text-blue-200 transition-colors text-sm disabled:opacity-70"
      >
        {sampleBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
        {sampleBusy ? sampleLabel : t('dropzone.trySample')}
      </button>
      <p className="text-neutral-600 text-xs mt-1">{t('dropzone.sampleHint')}</p>

      {sampleError && (
        <p className="text-red-400 text-xs mt-2">{sampleError}</p>
      )}
    </div>
  );
}
