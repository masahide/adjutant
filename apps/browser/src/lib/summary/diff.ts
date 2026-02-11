export type SummaryDiffLineType = "context" | "add" | "remove";

export type SummaryDiffLine = {
  type: SummaryDiffLineType;
  value: string;
};

export function diffSummary(before: string, after: string): SummaryDiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  const lcsMatrix = buildLcsMatrix(beforeLines, afterLines);
  const result: SummaryDiffLine[] = [];

  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: "context", value: beforeLines[i] });
      i += 1;
      j += 1;
      continue;
    }
    const nextDelete = lcsMatrix[i + 1][j];
    const nextInsert = lcsMatrix[i][j + 1];
    if (nextDelete >= nextInsert) {
      result.push({ type: "remove", value: beforeLines[i] });
      i += 1;
    } else {
      result.push({ type: "add", value: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    result.push({ type: "remove", value: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    result.push({ type: "add", value: afterLines[j] });
    j += 1;
  }

  return compactAdjacentContext(result);
}

function splitLines(input: string): string[] {
  if (!input) {
    return [];
  }
  return input.split(/\r?\n/);
}

function buildLcsMatrix(a: string[], b: string[]): number[][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        matrix[i][j] = matrix[i + 1][j + 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
  }
  return matrix;
}

function compactAdjacentContext(lines: SummaryDiffLine[]): SummaryDiffLine[] {
  const result: SummaryDiffLine[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      buffer.forEach((value) => result.push({ type: "context", value }));
      buffer = [];
    }
  };

  for (const line of lines) {
    if (line.type === "context") {
      buffer.push(line.value);
    } else {
      flush();
      result.push(line);
    }
  }
  flush();
  return result;
}
