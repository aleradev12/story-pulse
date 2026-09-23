function extractJson(content) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch (error) {
    throw new Error(`Sber returned invalid JSON: ${clean.slice(0, 500)}`, { cause: error });
  }
}

function isRetryableNetworkError(error) {
  return error instanceof TypeError && error.message === "fetch failed";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSberClient({ apiKey, baseUrl, model, maxRetries = 2 }) {
  if (!apiKey) throw new Error("SBER_API_KEY is missing");

  async function requestOnce(messages, { maxTokens, temperature }) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(90_000)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(`Sber API error: ${message}`);
    }

    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new Error(
        `Sber returned an empty response (finish_reason: ${choice?.finish_reason || "unknown"}). ` +
          `This usually means max_tokens was too low for the model's reasoning + answer.`
      );
    }

    return {
      data: extractJson(content),
      usage: body.usage || null
    };
  }

  return async function askSber(messages, { maxTokens = 1800, temperature = 0.7 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await requestOnce(messages, { maxTokens, temperature });
      } catch (error) {
        lastError = error;
        if (!isRetryableNetworkError(error) || attempt === maxRetries) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError;
  };
}
