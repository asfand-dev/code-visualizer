export function formatDate(iso: string, locale = 'en-GB'): string {
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}

export function readingTime(text: string, wpm = 220): number {
  return Math.max(1, Math.round(text.split(/\s+/).length / wpm));
}
