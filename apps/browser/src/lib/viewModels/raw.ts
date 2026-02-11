export interface RawFileEntry {
  source: string;
  path: string;
  lines: string[];
}

export interface RawPageData {
  date: string;
  sources: string[];
  files: RawFileEntry[];
}
