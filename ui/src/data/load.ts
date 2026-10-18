import type { ReportData } from '../types';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support DecompressionStream. Please open the report in a recent Chrome, Edge, Firefox or Safari.');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Reads the analysis embedded by the CLI (or the dev data file during UI development). */
export async function loadReportData(): Promise<ReportData> {
  const el = document.getElementById('cv-data');
  const raw = el?.textContent?.trim();
  if (el && raw) {
    const encoding = el.getAttribute('data-encoding');
    const text = encoding === 'gzip-base64' ? await gunzip(base64ToBytes(raw)) : raw;
    return JSON.parse(text) as ReportData;
  }
  if (import.meta.env.DEV) {
    const res = await fetch('/dev-data.json');
    if (!res.ok) throw new Error('Run "npm run dev" (it generates ui/dev-data.json) to develop the UI.');
    return (await res.json()) as ReportData;
  }
  throw new Error('No analysis data found in this report file.');
}
