export type ResponseBodyClient = {
  Network: {
    getResponseBody(params: {
      requestId: string;
    }): Promise<{ body: string; base64Encoded: boolean }>;
  };
};

export type ReadTextResult = {
  text: string | null;
  unavailable: boolean;
};

export type ReadJsonResult = {
  data: unknown | null;
  text: string | null;
  unavailable: boolean;
  invalidJson: boolean;
};

export class ResponseBodyReader {
  constructor(private readonly client: ResponseBodyClient) {}

  async readText(requestId: string): Promise<ReadTextResult> {
    try {
      const { body, base64Encoded } = await this.client.Network.getResponseBody({ requestId });
      return {
        text: base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body,
        unavailable: false,
      };
    } catch {
      return { text: null, unavailable: true };
    }
  }

  async readJson(requestId: string): Promise<ReadJsonResult> {
    const textResult = await this.readText(requestId);
    if (textResult.unavailable || textResult.text == null) {
      return {
        data: null,
        text: textResult.text,
        unavailable: textResult.unavailable,
        invalidJson: false,
      };
    }

    try {
      return {
        data: JSON.parse(textResult.text),
        text: textResult.text,
        unavailable: false,
        invalidJson: false,
      };
    } catch {
      return {
        data: null,
        text: textResult.text,
        unavailable: false,
        invalidJson: true,
      };
    }
  }
}
