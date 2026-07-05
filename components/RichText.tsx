import { sanitizeRichText } from '@/lib/sanitize';

interface RichTextProps {
  html: string;
  className?: string;
}

// Sanitizes again at render time (defense in depth) even though input is
// already sanitized on save — cheap, and protects against any stored value
// that bypassed that step (old data, a future different client, etc.).
export function RichText({ html, className }: RichTextProps) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: sanitizeRichText(html) }} />;
}
