// Chat and Embedding connections are deliberately independent.
export const EMBEDDING_DIMENSION = 1024; // Legacy Convex vector index only.
export type ModelProvider = 'openai' | 'together' | 'ollama' | 'custom';
export interface ChatConfig {
  provider: ModelProvider;
  url: string;
  chatModel: string;
  stopWords: string[];
  apiKey?: string;
}
export interface EmbeddingConfig {
  provider: ModelProvider;
  url: string;
  embeddingModel: string;
  apiKey?: string;
  dimensions: number;
  queryPrefix?: string;
  documentPrefix?: string;
}
export interface LLMConfig extends ChatConfig {
  embeddingModel: string;
}
function environmentProvider(prefix: 'CHAT' | 'EMBEDDING'): ModelProvider {
  const explicit = process.env[`${prefix}_PROVIDER`] ?? process.env.LLM_PROVIDER;
  if (explicit) {
    if (!['openai', 'together', 'ollama', 'custom'].includes(explicit))
      throw new Error(`Invalid ${prefix}_PROVIDER`);
    return explicit as ModelProvider;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.TOGETHER_API_KEY) return 'together';
  if (process.env.LLM_API_URL) return 'custom';
  return 'ollama';
}
function environmentConnection(prefix: 'CHAT' | 'EMBEDDING') {
  const provider = environmentProvider(prefix);
  const defaults = {
    openai: ['https://api.openai.com', process.env.OPENAI_API_KEY],
    together: ['https://api.together.xyz', process.env.TOGETHER_API_KEY],
    ollama: [process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434', undefined],
    custom: [process.env.LLM_API_URL, process.env.LLM_API_KEY],
  }[provider];
  const url = process.env[`${prefix}_API_URL`] ?? defaults[0];
  if (!url) throw new Error(`${prefix}_API_URL is required`);
  return {
    provider,
    url: url.replace(/\/$/, ''),
    apiKey: process.env[`${prefix}_API_KEY`] ?? defaults[1],
  };
}
export function getChatConfig(): ChatConfig {
  const connection = environmentConnection('CHAT');
  const models = {
    openai: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
    together: process.env.TOGETHER_CHAT_MODEL ?? 'meta-llama/Llama-3-8b-chat-hf',
    ollama: process.env.OLLAMA_MODEL ?? 'llama3',
    custom: process.env.LLM_MODEL,
  };
  const chatModel = process.env.CHAT_MODEL ?? models[connection.provider];
  if (!chatModel) throw new Error('CHAT_MODEL or LLM_MODEL is required');
  return {
    ...connection,
    chatModel,
    stopWords:
      connection.provider === 'ollama' || connection.provider === 'together' ? ['<|eot_id|>'] : [],
  };
}
export function getEmbeddingConfig(): EmbeddingConfig {
  const connection = environmentConnection('EMBEDDING');
  const models = {
    openai: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-ada-002',
    together: process.env.TOGETHER_EMBEDDING_MODEL ?? 'togethercomputer/m2-bert-80M-8k-retrieval',
    ollama: process.env.OLLAMA_EMBEDDING_MODEL ?? 'mxbai-embed-large',
    custom: process.env.LLM_EMBEDDING_MODEL,
  };
  const embeddingModel = process.env.EMBEDDING_MODEL ?? models[connection.provider];
  if (!embeddingModel) throw new Error('EMBEDDING_MODEL or LLM_EMBEDDING_MODEL is required');
  const dimensions = Number(
    process.env.EMBEDDING_DIMENSIONS ??
      { openai: 1536, together: 768, ollama: 1024, custom: 1024 }[connection.provider],
  );
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16384)
    throw new Error('Invalid EMBEDDING_DIMENSIONS');
  return { ...connection, embeddingModel, dimensions };
}
export function getLLMConfig(): LLMConfig {
  return { ...getChatConfig(), embeddingModel: getEmbeddingConfig().embeddingModel };
}
export function detectMismatchedLLMProvider() {
  getEmbeddingConfig();
}
export function modelEndpoint(url: string, path: string) {
  return (
    url.replace(/\/$/, '') +
    (url.replace(/\/$/, '').endsWith('/v1') ? path.replace(/^\/v1/, '') : path)
  );
}
const AuthHeaders = (config: { apiKey?: string }): Record<string, string> =>
  config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {};

export interface ChatRequestOptions {
  /** Absolute deadline for the entire request, including retries and backoff. */
  deadline?: number;
}

// Overload for non-streaming
export async function chatCompletion(
  body: Omit<CreateChatCompletionRequest, 'model'> & {
    model?: CreateChatCompletionRequest['model'];
  } & {
    stream?: false | null | undefined;
  },
  configOverride?: ChatConfig,
  options?: ChatRequestOptions,
): Promise<{ content: string; retries: number; ms: number }>;
// Overload for streaming
export async function chatCompletion(
  body: Omit<CreateChatCompletionRequest, 'model'> & {
    model?: CreateChatCompletionRequest['model'];
  } & {
    stream?: true;
  },
  configOverride?: ChatConfig,
): Promise<{ content: ChatCompletionContent; retries: number; ms: number }>;
export async function chatCompletion(
  body: Omit<CreateChatCompletionRequest, 'model'> & {
    model?: CreateChatCompletionRequest['model'];
  },
  configOverride?: ChatConfig,
  options?: ChatRequestOptions,
) {
  const config = configOverride ?? getChatConfig();
  body.model = body.model ?? config.chatModel;
  body = { ...body };
  const stopWords = body.stop ? (typeof body.stop === 'string' ? [body.stop] : body.stop) : [];
  if (config.stopWords) stopWords.push(...config.stopWords);
  if (stopWords.length) body.stop = [...new Set(stopWords)];
  const controller = options?.deadline === undefined ? undefined : new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (controller) {
    if (!Number.isSafeInteger(options!.deadline)) throw new Error('INVALID_CHAT_DEADLINE');
    const remaining = options!.deadline! - Date.now();
    if (remaining <= 0) throw new Error('CHAT_REQUEST_DEADLINE');
    if (remaining > 2_147_483_647) throw new Error('INVALID_CHAT_DEADLINE');
    deadlineTimer = setTimeout(() => controller.abort(), remaining);
  }
  try {
    const {
      result: content,
      retries,
      ms,
    } = await retryWithBackoff(async () => {
      const result = await fetch(modelEndpoint(config.url, '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...AuthHeaders(config),
        },

        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (!result.ok) {
        const error = await result.text();
        console.error({ error });
        if (result.status === 404 && config.provider === 'ollama') {
          await tryPullOllama(body.model!, error, config.url);
        }
        throw {
          retry: result.status === 429 || result.status >= 500,
          error: new Error(`Chat completion failed with code ${result.status}: ${error}`),
        };
      }
      if (body.stream) {
        return new ChatCompletionContent(result.body!, stopWords);
      } else {
        const json = (await result.json()) as CreateChatCompletionResponse;
        const choice = json.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          // Reasoning is provider metadata, never a resident's executable action.
          // Keep diagnostics useful without persisting prompts, reasoning, or credentials.
          throw new Error(
            'EMPTY_CHAT_RESPONSE: ' +
              JSON.stringify({
                model: typeof json.model === 'string' ? json.model.slice(0, 256) : undefined,
                finishReason: choice?.finish_reason,
                completionTokens: json.usage?.completion_tokens,
                reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens,
                reasoningChars: choice?.message?.reasoning_content?.length,
              }),
          );
        }
        return content;
      }
    }, controller?.signal);

    return {
      content,
      retries,
      ms,
    };
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('CHAT_REQUEST_DEADLINE');
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

export async function tryPullOllama(model: string, error: string, url = getChatConfig().url) {
  if (error.includes('try pulling')) {
    console.error('Embedding model not found, pulling from Ollama');
    const pullResp = await fetch(url + '/api/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: model }),
    });
    console.log('Pull response', await pullResp.text());
    throw { retry: true, error: `Dynamically pulled model. Original error: ${error}` };
  }
}

export async function fetchEmbeddingBatch(
  texts: string[],
  config = getEmbeddingConfig(),
  inputMode: 'query' | 'document' = 'document',
) {
  if (!texts.length) return { ollama: config.provider === 'ollama', embeddings: [] as number[][] };
  const prefix = inputMode === 'query' ? (config.queryPrefix ?? '') : (config.documentPrefix ?? '');
  texts = texts.map((text) => prefix + text.replace(/\n/g, ' '));
  if (config.provider === 'ollama') {
    return {
      ollama: true as const,
      embeddings: await Promise.all(
        texts.map(async (t) => (await ollamaFetchEmbedding(t, config)).embedding),
      ),
    };
  }
  const {
    result: json,
    retries,
    ms,
  } = await retryWithBackoff(async () => {
    const result = await fetch(modelEndpoint(config.url, '/v1/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AuthHeaders(config),
      },

      body: JSON.stringify({
        model: config.embeddingModel,
        input: texts.map((text) => text.replace(/\n/g, ' ')),
      }),
    });
    if (!result.ok) {
      throw {
        retry: result.status === 429 || result.status >= 500,
        error: new Error(`Embedding failed with code ${result.status}: ${await result.text()}`),
      };
    }
    return (await result.json()) as CreateEmbeddingResponse;
  });
  if (json.data.length !== texts.length) {
    console.error(json);
    throw new Error('Unexpected number of embeddings');
  }
  if (
    json.data.some(
      (item, i, rows) =>
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= texts.length ||
        rows.some((other, j) => j !== i && other.index === item.index),
    )
  )
    throw new Error('INVALID_EMBEDDING_RESPONSE_INDEX');
  const allembeddings = json.data;
  allembeddings.sort((a, b) => a.index - b.index);
  return {
    ollama: false as const,
    embeddings: allembeddings.map(({ embedding }) => embedding),
    usage: json.usage?.total_tokens,
    retries,
    ms,
  };
}

export async function fetchEmbedding(
  text: string,
  config = getEmbeddingConfig(),
  inputMode: 'query' | 'document' = 'document',
) {
  const { embeddings, ...stats } = await fetchEmbeddingBatch([text], config, inputMode);
  return { embedding: embeddings[0], ...stats };
}

export async function fetchModeration(content: string) {
  const config = getChatConfig();
  const { result: flagged } = await retryWithBackoff(async () => {
    const result = await fetch(config.url + '/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AuthHeaders(config),
      },

      body: JSON.stringify({
        input: content,
      }),
    });
    if (!result.ok) {
      throw {
        retry: result.status === 429 || result.status >= 500,
        error: new Error(`Embedding failed with code ${result.status}: ${await result.text()}`),
      };
    }
    return (await result.json()) as { results: { flagged: boolean }[] };
  });
  return flagged;
}

// Retry after this much time, based on the retry number.
const RETRY_BACKOFF = [1000, 10_000, 20_000]; // In ms
const RETRY_JITTER = 100; // In ms
type RetryError = { retry: boolean; error: any };

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ retries: number; result: T; ms: number }> {
  let i = 0;
  for (; i <= RETRY_BACKOFF.length; i++) {
    try {
      if (signal?.aborted) throw new Error('CHAT_REQUEST_DEADLINE');
      const start = Date.now();
      const result = await fn();
      if (signal?.aborted) throw new Error('CHAT_REQUEST_DEADLINE');
      const ms = Date.now() - start;
      return { result, retries: i, ms };
    } catch (e) {
      const retryError = e as RetryError;
      if (i < RETRY_BACKOFF.length) {
        if (retryError.retry) {
          console.log(
            `Attempt ${i + 1} failed, waiting ${RETRY_BACKOFF[i]}ms to retry...`,
            Date.now(),
          );
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new Error('CHAT_REQUEST_DEADLINE'));
            };
            const timer = setTimeout(
              () => {
                signal?.removeEventListener('abort', abort);
                resolve();
              },
              RETRY_BACKOFF[i] + RETRY_JITTER * Math.random(),
            );
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
          continue;
        }
      }
      if (retryError.error) throw retryError.error;
      else throw e;
    }
  }
  throw new Error('Unreachable');
}

// Lifted from openai's package
export interface LLMMessage {
  /**
   * The contents of the message. `content` is required for all messages, and may be
   * null for assistant messages with function calls.
   */
  content: string | null;

  /**
   * The role of the messages author. One of `system`, `user`, `assistant`, or
   * `function`.
   */
  role: 'system' | 'user' | 'assistant' | 'function';

  /**
   * The name of the author of this message. `name` is required if role is
   * `function`, and it should be the name of the function whose response is in the
   * `content`. May contain a-z, A-Z, 0-9, and underscores, with a maximum length of
   * 64 characters.
   */
  name?: string;

  /**
   * The name and arguments of a function that should be called, as generated by the model.
   */
  function_call?: {
    // The name of the function to call.
    name: string;
    /**
     * The arguments to call the function with, as generated by the model in
     * JSON format. Note that the model does not always generate valid JSON,
     * and may hallucinate parameters not defined by your function schema.
     * Validate the arguments in your code before calling your function.
     */
    arguments: string;
  };
}

// Non-streaming chat completion response
interface CreateChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index?: number;
    message?: {
      role: 'system' | 'user' | 'assistant';
      content: string | null;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }[];
  usage?: {
    completion_tokens: number;

    prompt_tokens: number;

    total_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface CreateEmbeddingResponse {
  data: {
    index: number;
    object: string;
    embedding: number[];
  }[];
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface CreateChatCompletionRequest {
  /**
   * ID of the model to use.
   * @type {string}
   * @memberof CreateChatCompletionRequest
   */
  model: string;
  // | 'gpt-4'
  // | 'gpt-4-0613'
  // | 'gpt-4-32k'
  // | 'gpt-4-32k-0613'
  // | 'gpt-3.5-turbo'; // <- our default
  /**
   * The messages to generate chat completions for, in the chat format:
   * https://platform.openai.com/docs/guides/chat/introduction
   * @type {Array<ChatCompletionRequestMessage>}
   * @memberof CreateChatCompletionRequest
   */
  messages: LLMMessage[];
  /**
   * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.  We generally recommend altering this or `top_p` but not both.
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  temperature?: number | null;
  /**
   * An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.  We generally recommend altering this or `temperature` but not both.
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  top_p?: number | null;
  /**
   * How many chat completion choices to generate for each input message.
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  n?: number | null;
  /**
   * If set, partial message deltas will be sent, like in ChatGPT. Tokens will be sent as data-only [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format) as they become available, with the stream terminated by a `data: [DONE]` message.
   * @type {boolean}
   * @memberof CreateChatCompletionRequest
   */
  stream?: boolean | null;
  /**
   *
   * @type {CreateChatCompletionRequestStop}
   * @memberof CreateChatCompletionRequest
   */
  stop?: Array<string> | string;
  /**
   * The maximum number of tokens allowed for the generated answer. By default,
   * the number of tokens the model can return will be (4096 - prompt tokens).
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  max_tokens?: number;
  /**
   * Number between -2.0 and 2.0. Positive values penalize new tokens based on
   * whether they appear in the text so far, increasing the model\'s likelihood
   * to talk about new topics. See more information about frequency and
   * presence penalties:
   * https://platform.openai.com/docs/api-reference/parameter-details
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  presence_penalty?: number | null;
  /**
   * Number between -2.0 and 2.0. Positive values penalize new tokens based on
   * their existing frequency in the text so far, decreasing the model\'s
   * likelihood to repeat the same line verbatim. See more information about
   * presence penalties:
   * https://platform.openai.com/docs/api-reference/parameter-details
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  frequency_penalty?: number | null;
  /**
   * Modify the likelihood of specified tokens appearing in the completion.
   * Accepts a json object that maps tokens (specified by their token ID in the
   * tokenizer) to an associated bias value from -100 to 100. Mathematically,
   * the bias is added to the logits generated by the model prior to sampling.
   * The exact effect will vary per model, but values between -1 and 1 should
   * decrease or increase likelihood of selection; values like -100 or 100
   * should result in a ban or exclusive selection of the relevant token.
   * @type {object}
   * @memberof CreateChatCompletionRequest
   */
  logit_bias?: object | null;
  /**
   * A unique identifier representing your end-user, which can help OpenAI to
   * monitor and detect abuse. Learn more:
   * https://platform.openai.com/docs/guides/safety-best-practices/end-user-ids
   * @type {string}
   * @memberof CreateChatCompletionRequest
   */
  user?: string;
  tools?: {
    // The type of the tool. Currently, only function is supported.
    type: 'function';
    function: {
      /**
       * The name of the function to be called. Must be a-z, A-Z, 0-9, or
       * contain underscores and dashes, with a maximum length of 64.
       */
      name: string;
      /**
       * A description of what the function does, used by the model to choose
       * when and how to call the function.
       */
      description?: string;
      /**
       * The parameters the functions accepts, described as a JSON Schema
       * object. See the guide[1] for examples, and the JSON Schema reference[2]
       * for documentation about the format.
       * [1]: https://platform.openai.com/docs/guides/gpt/function-calling
       * [2]: https://json-schema.org/understanding-json-schema/
       * To describe a function that accepts no parameters, provide the value
       * {"type": "object", "properties": {}}.
       */
      parameters: object;
    };
  }[];
  /**
   * Controls which (if any) function is called by the model. `none` means the
   * model will not call a function and instead generates a message.
   * `auto` means the model can pick between generating a message or calling a
   * function. Specifying a particular function via
   * {"type: "function", "function": {"name": "my_function"}} forces the model
   * to call that function.
   *
   * `none` is the default when no functions are present.
   * `auto` is the default if functions are present.
   */
  tool_choice?:
    | 'none' // none means the model will not call a function and instead generates a message.
    | 'auto' // auto means the model can pick between generating a message or calling a function.
    // Specifies a tool the model should use. Use to force the model to call
    // a specific function.
    | {
        // The type of the tool. Currently, only function is supported.
        type: 'function';
        function: { name: string };
      };
  // Replaced by "tools"
  // functions?: {
  //   /**
  //    * The name of the function to be called. Must be a-z, A-Z, 0-9, or
  //    * contain underscores and dashes, with a maximum length of 64.
  //    */
  //   name: string;
  //   /**
  //    * A description of what the function does, used by the model to choose
  //    * when and how to call the function.
  //    */
  //   description?: string;
  //   /**
  //    * The parameters the functions accepts, described as a JSON Schema
  //    * object. See the guide[1] for examples, and the JSON Schema reference[2]
  //    * for documentation about the format.
  //    * [1]: https://platform.openai.com/docs/guides/gpt/function-calling
  //    * [2]: https://json-schema.org/understanding-json-schema/
  //    * To describe a function that accepts no parameters, provide the value
  //    * {"type": "object", "properties": {}}.
  //    */
  //   parameters: object;
  // }[];
  // /**
  //  * Controls how the model responds to function calls. "none" means the model
  //  * does not call a function, and responds to the end-user. "auto" means the
  //  * model can pick between an end-user or calling a function. Specifying a
  //  * particular function via {"name":\ "my_function"} forces the model to call
  //  *  that function.
  //  * - "none" is the default when no functions are present.
  //  * - "auto" is the default if functions are present.
  //  */
  // function_call?: 'none' | 'auto' | { name: string };
  /**
   * An object specifying the format that the model must output.
   *
   * Setting to { "type": "json_object" } enables JSON mode, which guarantees
   * the message the model generates is valid JSON.
   * *Important*: when using JSON mode, you must also instruct the model to
   * produce JSON yourself via a system or user message. Without this, the model
   * may generate an unending stream of whitespace until the generation reaches
   * the token limit, resulting in a long-running and seemingly "stuck" request.
   * Also note that the message content may be partially cut off if
   * finish_reason="length", which indicates the generation exceeded max_tokens
   * or the conversation exceeded the max context length.
   */
  response_format?: { type: 'text' | 'json_object' };
}

// Checks whether a suffix of s1 is a prefix of s2. For example,
// ('Hello', 'Kira:') -> false
// ('Hello Kira', 'Kira:') -> true
const suffixOverlapsPrefix = (s1: string, s2: string) => {
  for (let i = 1; i <= Math.min(s1.length, s2.length); i++) {
    const suffix = s1.substring(s1.length - i);
    const prefix = s2.substring(0, i);
    if (suffix === prefix) {
      return true;
    }
  }
  return false;
};

export class ChatCompletionContent {
  private readonly body: ReadableStream<Uint8Array>;
  private readonly stopWords: string[];

  constructor(body: ReadableStream<Uint8Array>, stopWords: string[]) {
    this.body = body;
    this.stopWords = stopWords;
  }

  async *readInner() {
    for await (const data of this.splitStream(this.body)) {
      if (data.startsWith('data: ')) {
        try {
          const json = JSON.parse(data.substring('data: '.length)) as {
            choices: { delta: { content?: string } }[];
          };
          if (json.choices[0].delta.content) {
            yield json.choices[0].delta.content;
          }
        } catch (e) {
          // e.g. the last chunk is [DONE] which is not valid JSON.
        }
      }
    }
  }

  // stop words in OpenAI api don't always work.
  // So we have to truncate on our side.
  async *read() {
    let lastFragment = '';
    for await (const data of this.readInner()) {
      lastFragment += data;
      let hasOverlap = false;
      for (const stopWord of this.stopWords) {
        const idx = lastFragment.indexOf(stopWord);
        if (idx >= 0) {
          yield lastFragment.substring(0, idx);
          return;
        }
        if (suffixOverlapsPrefix(lastFragment, stopWord)) {
          hasOverlap = true;
        }
      }
      if (hasOverlap) continue;
      yield lastFragment;
      lastFragment = '';
    }
    yield lastFragment;
  }

  async readAll() {
    let allContent = '';
    for await (const chunk of this.read()) {
      allContent += chunk;
    }
    return allContent;
  }

  async *splitStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let lastFragment = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush the last fragment now that we're done
          if (lastFragment !== '') {
            yield lastFragment;
          }
          break;
        }
        const data = new TextDecoder().decode(value);
        lastFragment += data;
        const parts = lastFragment.split('\n\n');
        // Yield all except for the last part
        for (let i = 0; i < parts.length - 1; i += 1) {
          yield parts[i];
        }
        // Save the last part as the new last fragment
        lastFragment = parts[parts.length - 1];
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export async function ollamaFetchEmbedding(text: string, config = getEmbeddingConfig()) {
  const { result } = await retryWithBackoff(async () => {
    const resp = await fetch(config.url + '/api/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.embeddingModel, prompt: text }),
    });
    if (!resp.ok) {
      const error = await resp.text();
      await tryPullOllama(config.embeddingModel, error, config.url);
      throw new Error(`Failed to fetch embeddings: ${resp.status}`);
    }
    return (await resp.json()).embedding as number[];
  });
  return { embedding: result };
}
