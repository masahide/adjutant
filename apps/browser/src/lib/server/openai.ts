import OpenAI from "openai";

export type OpenAIClient = OpenAI;

export async function createOpenAIClient(options: { apiKey: string }): Promise<OpenAIClient> {
  try {
    return new OpenAI({ apiKey: options.apiKey });
  } catch (error) {
    throw new Error("OpenAI SDK が見つかりません。`pnpm add openai` を実行してください。", {
      cause: error,
    });
  }
}
