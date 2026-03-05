export type MigrationAuditStatus = "done" | "deferred" | "non-scope";

export type MigrationAuditRecord = {
  legacyPath: string;
  acpPath: string;
  phase: "A/B" | "C" | "D" | "E" | "F";
  status: MigrationAuditStatus;
  evidenceSpec: string;
  evidenceTests: string;
  evidenceFiles: string;
  note: string;
};

export type MigrationAuditViolation = {
  row: number;
  field: string;
  reason: string;
};

const REQUIRED_HEADERS = [
  "legacyPath",
  "acpPath",
  "phase",
  "status",
  "evidence.spec",
  "evidence.tests",
  "evidence.files",
  "note",
] as const;

export function parseMigrationAuditMarkdown(markdown: string): MigrationAuditRecord[] {
  const lines = markdown.split(/\r?\n/);
  const tableRows = lines.filter((line) => line.trim().startsWith("|"));
  if (tableRows.length < 3) {
    return [];
  }

  const headerCells = splitMarkdownRow(tableRows[0] ?? "");
  const expected = [...REQUIRED_HEADERS];
  if (headerCells.length < expected.length) {
    return [];
  }
  for (let i = 0; i < expected.length; i += 1) {
    if ((headerCells[i] ?? "") !== expected[i]) {
      return [];
    }
  }

  const records: MigrationAuditRecord[] = [];
  for (let index = 2; index < tableRows.length; index += 1) {
    const row = tableRows[index] ?? "";
    if (row.includes("---")) {
      continue;
    }
    const cells = splitMarkdownRow(row);
    if (cells.length < expected.length) {
      continue;
    }

    records.push({
      legacyPath: cells[0] ?? "",
      acpPath: cells[1] ?? "",
      phase: (cells[2] ?? "") as MigrationAuditRecord["phase"],
      status: (cells[3] ?? "") as MigrationAuditStatus,
      evidenceSpec: cells[4] ?? "",
      evidenceTests: cells[5] ?? "",
      evidenceFiles: cells[6] ?? "",
      note: cells[7] ?? "",
    });
  }

  return records;
}

export function validateMigrationAuditRecords(
  records: MigrationAuditRecord[]
): MigrationAuditViolation[] {
  const violations: MigrationAuditViolation[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const row = index + 1;
    const record = records[index];
    if (record === undefined) {
      continue;
    }

    if (!isFilled(record.legacyPath)) {
      violations.push({ row, field: "legacyPath", reason: "required" });
    }
    if (!isFilled(record.acpPath)) {
      violations.push({ row, field: "acpPath", reason: "required" });
    }
    if (!isFilled(record.phase)) {
      violations.push({ row, field: "phase", reason: "required" });
    }
    if (!isStatus(record.status)) {
      violations.push({ row, field: "status", reason: "invalid_status" });
    }
    if (!hasEvidence(record.evidenceSpec)) {
      violations.push({ row, field: "evidence.spec", reason: "missing_evidence" });
    }
    if (!hasEvidence(record.evidenceTests)) {
      violations.push({ row, field: "evidence.tests", reason: "missing_evidence" });
    }
    if (!hasEvidence(record.evidenceFiles)) {
      violations.push({ row, field: "evidence.files", reason: "missing_evidence" });
    }
    if (!isFilled(record.note)) {
      violations.push({ row, field: "note", reason: "required" });
    }
  }

  return violations;
}

function splitMarkdownRow(row: string): string[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function isFilled(value: string): boolean {
  return value.trim().length > 0;
}

function hasEvidence(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  if (normalized === "-" || normalized === "none") {
    return false;
  }
  return true;
}

function isStatus(value: string): value is MigrationAuditStatus {
  return value === "done" || value === "deferred" || value === "non-scope";
}
