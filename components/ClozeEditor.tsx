'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { clozeBlankLetters } from '@/lib/cloze';
import { Checkbox } from './Checkbox';

interface ClozeEditorProps {
  /** {{A}}-style draft text, its letter->answer map, and the "separate
   * cards" checkbox state — read once, at mount, to seed the editor. The
   * add-card modal and CardRow's edit form both remount this component
   * fresh whenever they need new initial content (switching card type,
   * opening/closing edit mode), so there's no need to react to these props
   * changing after that. */
  initialText: string;
  initialAnswers: Record<string, string>;
  initialSeparateCards: boolean;
  onChange: (text: string, answers: Record<string, string>, separateCards: boolean) => void;
}

const CHIP_CLASS =
  'inline-block rounded bg-neutral-700 px-1.5 text-xs font-semibold text-neutral-100 align-middle';

// Builds the contentEditable's seed HTML from a {{A}}-style draft via DOM
// APIs (not string concatenation), so the browser handles escaping any
// special characters in the surrounding text correctly.
function draftToHtml(template: string): string {
  const container = document.createElement('div');
  const lines = template.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) container.appendChild(document.createElement('br'));
    let last = 0;
    const re = /\{\{([A-Z])\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) container.appendChild(document.createTextNode(line.slice(last, m.index)));
      const chip = document.createElement('span');
      chip.dataset.blank = m[1];
      chip.setAttribute('contenteditable', 'false');
      chip.className = CHIP_CLASS;
      chip.textContent = m[1];
      container.appendChild(chip);
      last = m.index + m[0].length;
    }
    if (last < line.length) container.appendChild(document.createTextNode(line.slice(last)));
  });
  return container.innerHTML;
}

// The Text field is a contentEditable div so a blank can render as an actual
// inline chip (see insertBlank below), but the stored value stays plain text
// with {{A}}-style placeholders — never HTML — so it doesn't disturb the
// regex-based cloze parsing the rest of the app relies on. The DOM is the
// source of truth while editing; state is just a cache derived from it for
// validation, the Blanks list, and the onChange callback.
function serializeContent(el: HTMLElement): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Chrome normalizes a space next to an inline element boundary into
      // &nbsp; for display — flatten it back to a regular space in the
      // stored text.
      text += (node.textContent ?? '').replace(/\u00A0/g, ' ');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      const letter = element.dataset.blank;
      if (letter) text += `{{${letter}}}`;
      else if (element.tagName === 'BR') text += '\n';
    }
  }
  return text;
}

/** The "mark a blank, then fill in its answer" cloze authoring UI — shared
 * by the add-card modal and CardRow's edit form so creating and editing a
 * cloze note look and behave identically. */
export function ClozeEditor({
  initialText,
  initialAnswers,
  initialSeparateCards,
  onChange,
}: ClozeEditorProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(initialText);
  const [answers, setAnswers] = useState(initialAnswers);
  const [separateCards, setSeparateCards] = useState(initialSeparateCards);
  const [hint, setHint] = useState('');

  useLayoutEffect(() => {
    const el = textRef.current;
    if (el) el.innerHTML = draftToHtml(initialText);
    // Mount-only seed — see the initialText/initialAnswers doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleInput() {
    const el = textRef.current;
    if (!el) return;
    const serialized = serializeContent(el);
    // Drop answers for letters no longer in the text (e.g. its chip got
    // deleted) so a re-added letter doesn't come back pre-filled.
    const letters = clozeBlankLetters(serialized);
    const next: Record<string, string> = {};
    for (const letter of letters) next[letter] = answers[letter] ?? '';
    setText(serialized);
    setAnswers(next);
    setHint('');
    onChange(serialized, next, separateCards);
  }

  function handleAnswerChange(letter: string, value: string) {
    const next = { ...answers, [letter]: value };
    setAnswers(next);
    onChange(text, next, separateCards);
  }

  function handleSeparateCardsChange(value: boolean) {
    setSeparateCards(value);
    onChange(text, answers, value);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Force a flat <br> for line breaks instead of the browser default of
    // wrapping each line in its own <div> — keeps serializeContent's walk
    // (and the blank chips within it) simple across browsers.
    if (e.key === 'Enter') {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      handleInput();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    handleInput();
  }

  function insertBlank() {
    const el = textRef.current;
    if (!el) return;
    if (document.activeElement !== el) {
      setHint('Click into the text field first.');
      return;
    }
    const used = new Set(clozeBlankLetters(text));
    let letter = '';
    for (let i = 0; i < 26; i++) {
      const candidate = String.fromCharCode(65 + i);
      if (!used.has(candidate)) {
        letter = candidate;
        break;
      }
    }
    if (!letter) return; // all 26 letters already used

    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const chip = `<span data-blank="${letter}" contenteditable="false" class="${CHIP_CLASS}">${letter}</span>`;
    document.execCommand('insertHTML', false, chip);
    // The caret after insertHTML lands inside the chip's own (non-editable)
    // text node, not after it — any further typing or execCommand there is
    // a silent no-op. Move it to the parent's child list, right after the
    // chip, so typing continues normally from there.
    const inserted = el.querySelector(`[data-blank="${letter}"]`);
    if (inserted) {
      const after = document.createRange();
      after.setStartAfter(inserted);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    handleInput();
  }

  return (
    <>
      <div>
        <span className="text-xs text-neutral-500">Text</span>
        <div
          ref={textRef}
          contentEditable
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          data-placeholder="e.g. The capital of France is (click +)"
          className="mt-0.5 min-h-[4.5rem] w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none empty:before:text-neutral-500 empty:before:content-[attr(data-placeholder)]"
        />
        {hint && <p className="mt-1 text-xs text-red-400">{hint}</p>}
      </div>
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-500">Blanks</span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={insertBlank}
            aria-label="Add blank"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <Plus size={14} />
          </button>
        </div>
        {clozeBlankLetters(text).length === 0 ? (
          <p className="mt-0.5 text-xs text-neutral-600">
            Place your cursor in the text and click + to mark a blank.
          </p>
        ) : (
          <div className="mt-0.5 space-y-1.5">
            {clozeBlankLetters(text).map((letter) => (
              <div key={letter} className="flex items-center gap-2">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-neutral-700 text-xs font-semibold text-neutral-100">
                  {letter}
                </span>
                <input
                  value={answers[letter] ?? ''}
                  onChange={(e) => handleAnswerChange(letter, e.target.value)}
                  placeholder="Answer"
                  className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {clozeBlankLetters(text).length >= 2 && (
        <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
          <Checkbox checked={separateCards} onChange={handleSeparateCardsChange} />
          Create a separate card for each blank
        </label>
      )}
    </>
  );
}
