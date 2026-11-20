/**
 * 主流大模型预设分组与默认 Base URL 映射表
 * 从 SettingsView 中抽离，方便后续单独扩展新厂商/模型。
 */

export interface LlmModelPreset {
  id: string;
  label: string;
  baseUrl: string;
}

export interface LlmModelGroup {
  provider: string;
  dotClass: string;
  models: LlmModelPreset[];
}

export const LLM_MODEL_GROUPS: LlmModelGroup[] = [
  {
    provider: "DeepSeek",
    dotClass: "bg-blue-500",
    models: [
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        baseUrl: "https://api.deepseek.com",
      },
      {
        id: "deepseek-flash",
        label: "DeepSeek V4.1 Flash",
        baseUrl: "https://api.deepseek.com",
      },
    ],
  },
  {
    provider: "智谱 AI",
    dotClass: "bg-sky-500",
    models: [
      {
        id: "glm-5.3",
        label: "GLM-5.3",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
      },
      {
        id: "glm-5.2",
        label: "GLM-5.2",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
      },
    ],
  },
  {
    provider: "MiniMax",
    dotClass: "bg-rose-500",
    models: [
      {
        id: "MiniMax-M3.1-Flash",
        label: "MiniMax M3.1 Flash",
        baseUrl: "https://api.minimax.io/v1",
      },
      {
        id: "MiniMax-M3",
        label: "MiniMax M3",
        baseUrl: "https://api.minimax.io/v1",
      },
    ],
  },
  {
    provider: "Kimi",
    dotClass: "bg-zinc-500",
    models: [
      {
        id: "kimi-k3.1-pro",
        label: "Kimi K3.1 Pro",
        baseUrl: "https://api.moonshot.cn/v1",
      },
      {
        id: "kimi-k3.1-pro-highspeed",
        label: "Kimi K3.1 Highspeed",
        baseUrl: "https://api.moonshot.cn/v1",
      },
    ],
  },
  {
    provider: "Google",
    dotClass: "bg-emerald-500",
    models: [
      {
        id: "gemini-4-carbon",
        label: "Gemini 4 Carbon",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      },
      {
        id: "gemini-4-argon",
        label: "Gemini 4 Argon",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      },
      {
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      },
    ],
  },
  {
    provider: "OpenAI",
    dotClass: "bg-teal-500",
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        baseUrl: "https://api.openai.com/v1",
      },
      {
        id: "gpt-6.2-sol",
        label: "GPT-6.2 Sol",
        baseUrl: "https://api.openai.com/v1",
      },
      {
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        baseUrl: "https://api.openai.com/v1",
      },
    ],
  },
  {
    provider: "xAI",
    dotClass: "bg-neutral-500",
    models: [
      {
        id: "grok-4.7",
        label: "Grok 4.7",
        baseUrl: "https://api.x.ai/v1",
      },
      {
        id: "grok-build-0.1",
        label: "Grok Build 0.1",
        baseUrl: "https://api.x.ai/v1",
      },
    ],
  },
  {
    provider: "Claude",
    dotClass: "bg-amber-500",
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        baseUrl: "https://api.anthropic.com/v1/",
      },
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        baseUrl: "https://api.anthropic.com/v1/",
      },
    ],
  },
];

export const MODEL_PRESET_MAP: Record<
  string,
  LlmModelPreset & { provider: string; dotClass: string }
> = Object.fromEntries(
  LLM_MODEL_GROUPS.flatMap((group) =>
    group.models.map((m) => [
      m.id,
      { ...m, provider: group.provider, dotClass: group.dotClass },
    ]),
  ),
);

export const MODEL_BASE_URL_MAP: Record<string, string> = Object.fromEntries(
  LLM_MODEL_GROUPS.flatMap((group) =>
    group.models.map((m) => [m.id, m.baseUrl] as const),
  ),
);
