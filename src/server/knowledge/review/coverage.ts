/** A claimed full review must have actually obtained every selected source and the complete draft. */
export class KnowledgeReviewCoverage {
  private readonly ranges = new Map<string, { start: number; end: number }[]>();
  read(id: string, start: number, length: number) {
    const rows = [...(this.ranges.get(id) ?? []), { start, end: start + length }].sort((a, b) => a.start - b.start),
      merged: { start: number; end: number }[] = [];
    for (const row of rows) {
      const previous = merged[merged.length - 1];
      if (previous && row.start <= previous.end) previous.end = Math.max(previous.end, row.end);
      else merged.push({ ...row });
    }
    this.ranges.set(id, merged);
  }
  complete(id: string, length: number) {
    if (!length) return true;
    const ranges = this.ranges.get(id);
    return ranges?.length === 1 && ranges[0]!.start === 0 && ranges[0]!.end === length;
  }
}
