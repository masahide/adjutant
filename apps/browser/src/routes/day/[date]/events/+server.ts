import { json } from "@sveltejs/kit";

import { resolveDataDir } from "$lib/server/config";
import { readDailyEvents } from "$lib/server/data";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const date = params.date;
  if (!date) {
    return json({ error: "missing date" }, { status: 400 });
  }

  const dataDir = resolveDataDir();
  const result = await readDailyEvents({ dataDir, date, cache: false });
  return json(result, {
    headers: {
      "cache-control": "no-cache, no-store, must-revalidate",
    },
  });
};
