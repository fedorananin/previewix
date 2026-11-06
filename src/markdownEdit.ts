/** A block edit requested by the Markdown webview, in source lines `[start, end)`. */
export interface BlockEdit {
  start: number;
  end: number;
  text: string;
  /** Delete the lines altogether instead of leaving an empty one. */
  remove?: boolean;
}

/** A text replacement plus the line range the edited block occupies afterwards. */
export interface EditPlan {
  from: [line: number, character: number];
  to: [line: number, character: number];
  text: string;
  start: number;
  end: number;
}

const countLines = (text: string) => text.split('\n').length;

/** Turns a block edit into a replacement of exactly the affected lines, so the rest of the file stays byte-for-byte intact. */
export function planEdit(lines: string[], edit: BlockEdit): EditPlan {
  const last = lines.length - 1;
  const endOf = (line: number): [number, number] => [line, lines[line].length];

  if (edit.start >= edit.end) {
    // A new block at the end of the document, separated from the previous one by a blank line.
    if (lines.every((line) => line.trim() === '')) {
      return { from: [0, 0], to: endOf(last), text: edit.text, start: 0, end: countLines(edit.text) };
    }
    let trailing = 0;
    while (lines[last - trailing] === '') {
      trailing++;
    }
    const pad = Math.max(0, 2 - trailing);
    const start = last + pad;
    return { from: endOf(last), to: endOf(last), text: '\n'.repeat(pad) + edit.text, start, end: start + countLines(edit.text) };
  }

  const end = Math.min(edit.end, lines.length);
  if (edit.remove) {
    if (end < lines.length) {
      // The blank line that separated the block goes too, so no double gap (or dangling one at the end) is left.
      const blankBefore = edit.start > 0 && lines[edit.start - 1] === '';
      if (blankBefore && lines.slice(end).every((line) => line === '')) {
        return { from: [edit.start - 1, 0], to: [end, 0], text: '', start: edit.start, end: edit.start };
      }
      const gap = (blankBefore || edit.start === 0) && lines[end] === '';
      return { from: [edit.start, 0], to: [gap ? end + 1 : end, 0], text: '', start: edit.start, end: edit.start };
    }
    // The block is the tail of the file: take the line break before it instead of the one after.
    const from: [number, number] = edit.start > 0 ? endOf(edit.start - 1) : [0, 0];
    return { from, to: endOf(last), text: '', start: edit.start, end: edit.start };
  }
  return { from: [edit.start, 0], to: endOf(end - 1), text: edit.text, start: edit.start, end: edit.start + countLines(edit.text) };
}

/** Flips the first `[ ]` / `[x]` on a line; undefined when there is none. */
export function toggleTask(line: string): string | undefined {
  const toggled = line.replace(/\[([ xX])\]/, (_, mark) => (mark === ' ' ? '[x]' : '[ ]'));
  return toggled === line ? undefined : toggled;
}
