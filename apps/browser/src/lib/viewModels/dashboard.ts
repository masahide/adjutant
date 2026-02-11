export interface DashboardSourceCount {
  source: string;
  count: number;
}

export interface DashboardDay {
  date: string;
  total: number;
  sources: DashboardSourceCount[];
  hasSummary: boolean;
  summaryPreview: string | null;
}

export interface DashboardLoadData {
  days: DashboardDay[];
  generatedAt: string;
}
