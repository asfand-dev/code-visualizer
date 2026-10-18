import { Fragment, type ReactNode } from 'react';

/**
 * Minimal markdown renderer for analyzer-generated text (tour steps):
 * paragraphs, "- " bullet lists, **bold**, *italic* and `code`.
 * Inline code that names a project file becomes a clickable link.
 */
export function Markdown({ text, isFile, onFile }: { text: string; isFile?: (id: string) => boolean; onFile?: (id: string) => void }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="prose">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const out: ReactNode[] = [];
        let list: string[] = [];
        const flush = (key: string): void => {
          if (!list.length) return;
          out.push(
            <ul key={key}>
              {list.map((item, j) => (
                <li key={j}>{inline(item, isFile, onFile)}</li>
              ))}
            </ul>,
          );
          list = [];
        };
        lines.forEach((line, j) => {
          if (/^\s*[-*]\s+/.test(line)) list.push(line.replace(/^\s*[-*]\s+/, ''));
          else {
            flush(`l${j}`);
            if (line.trim()) out.push(<p key={`p${j}`}>{inline(line, isFile, onFile)}</p>);
          }
        });
        flush('end');
        return <Fragment key={i}>{out}</Fragment>;
      })}
    </div>
  );
}

function inline(text: string, isFile?: (id: string) => boolean, onFile?: (id: string) => void): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      const value = token.slice(1, -1);
      const clickable = isFile?.(value);
      parts.push(
        <code key={key++} className={clickable ? 'file-link' : undefined} onClick={clickable ? () => onFile?.(value) : undefined}>
          {value}
        </code>,
      );
    } else if (token.startsWith('**')) parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
