export type DiffLine = {
  type: "same" | "added" | "removed";
  content: string;
};

/** LCS-based line diff. Common prefix/suffix are trimmed first so the O(n·m)
 *  table only covers the changed middle region. */
export function computeDiff(original: string, modified: string): DiffLine[] {
  const a = original.split("\n");
  const b = modified.split("\n");
  const result: DiffLine[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) {
    result.push({ type: "same", content: a[i]! });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length > 0 || midB.length > 0) {
    // Bound the DP table (cells × 4 bytes ≈ 16MB at this cap). Above it,
    // fall back to a straight remove/add block rather than allocating.
    const cells = (midA.length + 1) * (midB.length + 1);
    if (cells <= 4_000_000) {
      result.push(...lcsDiff(midA, midB));
    } else {
      for (const line of midA) result.push({ type: "removed", content: line });
      for (const line of midB) result.push({ type: "added", content: line });
    }
  }

  for (let i = endA; i < a.length; i++) {
    result.push({ type: "same", content: a[i]! });
  }

  return result;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", content: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      out.push({ type: "removed", content: a[i]! });
      i++;
    } else {
      out.push({ type: "added", content: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "removed", content: a[i++]! });
  while (j < m) out.push({ type: "added", content: b[j++]! });
  return out;
}
