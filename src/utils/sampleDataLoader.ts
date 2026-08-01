import JSZip from 'jszip';

const SAMPLE_DATA_URL = '/sample-data/sample-knee-mri.zip';

export interface SampleDataProgress {
  phase: 'downloading' | 'extracting' | 'loading';
  percent: number;
}

export async function loadSampleData(
  onProgress?: (progress: SampleDataProgress) => void,
): Promise<File[]> {
  // Phase 1: Download zip with streaming progress
  onProgress?.({ phase: 'downloading', percent: 0 });

  const response = await fetch(SAMPLE_DATA_URL);
  if (!response.ok) throw new Error('Failed to download sample data');

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total > 0) {
      onProgress?.({ phase: 'downloading', percent: Math.round((loaded / total) * 100) });
    }
  }

  const blob = new Blob(chunks as BlobPart[]);

  // Phase 2: Extract zip
  onProgress?.({ phase: 'extracting', percent: 0 });
  const zip = await JSZip.loadAsync(blob);

  const files: File[] = [];
  const entries = Object.entries(zip.files).filter(([, f]) => !f.dir);
  // Skip known non-DICOM filenames
  const SKIP_NAMES = new Set(['dicomdir', 'readme', 'readme.txt', 'license', 'license.txt']);
  const SKIP_EXTENSIONS = new Set(['.xml', '.json', '.txt', '.csv', '.html', '.htm', '.pdf', '.jpg', '.png', '.gif', '.zip', '.md']);
  let extracted = 0;

  for (const [path, zipEntry] of entries) {
    extracted++;
    const fileName = path.split('/').pop() || path;
    const lower = fileName.toLowerCase();

    // Skip known non-DICOM files by name or extension
    if (SKIP_NAMES.has(lower)) {
      onProgress?.({ phase: 'extracting', percent: Math.round((extracted / entries.length) * 100) });
      continue;
    }
    const dotIdx = lower.lastIndexOf('.');
    if (dotIdx >= 0) {
      const ext = lower.slice(dotIdx);
      if (ext !== '.dcm' && SKIP_EXTENSIONS.has(ext)) {
        onProgress?.({ phase: 'extracting', percent: Math.round((extracted / entries.length) * 100) });
        continue;
      }
    }

    const data = await zipEntry.async('arraybuffer');

    // Validate DICM preamble (bytes 128-131 should be "DICM")
    if (data.byteLength >= 132) {
      const preamble = new Uint8Array(data, 128, 4);
      if (preamble[0] === 0x44 && preamble[1] === 0x49 && preamble[2] === 0x43 && preamble[3] === 0x4d) {
        const file = new File([data], fileName, { type: 'application/dicom' });
        files.push(file);
      }
    }

    onProgress?.({ phase: 'extracting', percent: Math.round((extracted / entries.length) * 100) });
  }

  // Phase 3: Ready to load
  onProgress?.({ phase: 'loading', percent: 100 });

  return files;
}
