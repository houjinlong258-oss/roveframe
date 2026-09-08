/** Source-adapted conservative repetition detector; see THIRD_PARTY_NOTICES.md. */
export function isRepetitionDominated(text: string): boolean {
  if (text.length < 400) return false;
  const lines = new Map<string, number>();
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line) lines.set(line, (lines.get(line) ?? 0) + 1);
  }
  for (const [line, count] of lines) {
    if (count >= 5 && count * line.length >= text.length * 0.5) return true;
  }
  const window = 60;
  const needed = Math.max(5, Math.ceil(text.length * 0.5 / window));
  const counts = new Map<string, number>();
  for (let i = 0; i <= text.length - window; i += 1) {
    const key = text.slice(i, i + window);
    const count = (counts.get(key) ?? 0) + 1;
    if (count >= needed) return true;
    counts.set(key, count);
  }
  return false;
}
