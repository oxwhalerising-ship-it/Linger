/**
 * ChatGPT Desktop 风格设置与长期记忆页（SettingsView）
 * ---------------------------------------------------
 * 采用 ChatGPT Desktop 原生设置弹窗的「左侧分类子导航 + 右侧聚焦表单」结构：
 * 1. 大脑与语音（大模型 API / 台湾腔 edge-tts 音色试听 / 本地 sherpa-onnx ASR）
 * 2. 作息与陪伴（全天 4 节点定时提醒 + 随机冒泡 + 免打扰）
 * 3. 离线唤醒（纯本地 sherpa-onnx KWS 唤醒词 + Windows 开机自启）
 * 4. 桌宠形象（内置精灵 / 自定义图片 / Live2D 预留 + 实时表情同步）
 * 5. 长期记忆（个人喜好 / 近期关心事件 / 历史高光管理）
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  api,
  type SttStatusData,
  type VoiceOption,
} from "../../services/api";
import { playTaiwanSentences } from "../../services/petApi";
import AvatarRenderer from "../pet/AvatarRenderer";
import ScheduleCard from "./ScheduleCard";
import WakewordCard from "./WakewordCard";
import {
  CORE_SIX_EMOTIONS,
  EMOTION_GROUPS,
  PET_EMOTION_META,
  type AvatarConfig,
  type PetEmotion,
} from "../../types/pet";
import {
  IconCheck,
  IconChevronDown,
  IconClock,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconSliders,
  IconSmile,
  IconTrash,
  IconVolumeOn,
  IconWaveform,
} from "./AppleIcons";

type SettingsSection = "general" | "schedule" | "wakeword" | "avatar";

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: ReactNode;
}> = [
  { id: "general", label: "大脑与语音", icon: <IconSliders className="w-4 h-4" /> },
  { id: "schedule", label: "作息与陪伴", icon: <IconClock className="w-4 h-4" /> },
  { id: "wakeword", label: "离线唤醒", icon: <IconWaveform className="w-4 h-4" /> },
  { id: "avatar", label: "桌宠形象", icon: <IconSmile className="w-4 h-4" /> },

];



import { useToast } from "../../hooks/useToast";
import {
  LLM_MODEL_GROUPS,
  MODEL_BASE_URL_MAP,
  MODEL_PRESET_MAP,
} from "./settings/llmPresets";

export default function SettingsView({initialSection="general"}:{initialSection?:"general"|"schedule"}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [botName, setBotName] = useState("灵儿");
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const customModelInputRef = useRef<HTMLInputElement | null>(null);

  const [ttsProvider, setTtsProvider] = useState<"edge_tts" | "fish_audio">(
    "edge_tts",
  );
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [fishModels, setFishModels] = useState<VoiceOption[]>([
    { id: "s2.1-pro", name: "s2.1-pro（主力推荐 · 高情感低延迟）" },
    { id: "s2.1-pro-free", name: "s2.1-pro-free（免费体验档 · 公平限额）" },
    { id: "s2-pro", name: "s2-pro（标准情感模型）" },
  ]);
  const [selectedVoice, setSelectedVoice] = useState("zh-TW-HsiaoChenNeural");
  const [voiceRate, setVoiceRate] = useState("+0%");
  const [fishApiKey, setFishApiKey] = useState("");
  const [showFishApiKey, setShowFishApiKey] = useState(false);
  const [fishReferenceId, setFishReferenceId] = useState("");
  const [fishModel, setFishModel] = useState("s2.1-pro");
  const [sttStatus, setSttStatus] = useState<SttStatusData | null>(null);

  const [previewEmotion, setPreviewEmotion] = useState<PetEmotion>("idle");
  const [previewPatting, setPreviewPatting] = useState(false);
  const [previewPatMood, setPreviewPatMood] = useState<"shy" | "happy">("shy");
  const [cleanValidation, setCleanValidation] = useState(false);
  const previewSvgRef = useRef<SVGSVGElement | null>(null);
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>({
    provider: "builtin-sprite",
  });

  const [saving, setSaving] = useState(false);
  const [probing,setProbing]=useState(false);
  const [testingVoice, setTestingVoice] = useState(false);
  const { toast, showToast } = useToast(2600);
  const voiceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      voiceAbortRef.current?.abort();
    };
  }, []);

  // 点击外部或按 Esc 自动收起自定义模型下拉弹层
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    const handleEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [modelMenuOpen]);

  const loadAll = useCallback(async () => {
    try {
      const [settingsData, voicesData, sttData] = await Promise.all([
        api.getSettings(),
        api.getVoices(),
        api.getSttStatus(),

      ]);

      const llm = (settingsData.llm as Record<string, string>) || {};
      const tts = (settingsData.tts as Record<string, string>) || {};

      const loadedModel = (llm.model || "gemini-3.8-flash").trim();
      const matchedBaseUrl = MODEL_BASE_URL_MAP[loadedModel];
      setBotName(String(settingsData.bot_name || "灵儿"));
      setModel(loadedModel);
      setIsCustomModel(!matchedBaseUrl);
      setBaseUrl(
        llm.base_url ||
          matchedBaseUrl ||
          "https://generativelanguage.googleapis.com/v1beta/openai/",
      );
      setApiKey(llm.api_key || "");

      setVoices(voicesData.voices || []);
      if (voicesData.fish_models?.length) {
        setFishModels(voicesData.fish_models);
      }
      setTtsProvider(tts.provider === "fish_audio" ? "fish_audio" : "edge_tts");
      setSelectedVoice(tts.voice || "zh-TW-HsiaoChenNeural");
      setVoiceRate(tts.rate || "+0%");
      setFishApiKey(tts.fish_api_key || "");
      setFishReferenceId(tts.fish_reference_id || "");
      setFishModel(tts.fish_model || "s2.1-pro");
      setSttStatus(sttData);

    } catch {
      showToast("加载设置失败，请检查后端是否启动");
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateSettings({
        bot_name: botName.trim() || "灵儿",
        llm: {
          provider: "openai_compatible",
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_key: apiKey.trim(),
        },
        tts: {
          provider: ttsProvider,
          voice: selectedVoice,
          rate: voiceRate,
          pitch: "+0Hz",
          enable_filler_sounds: true,
          fish_api_key: fishApiKey.trim(),
          fish_reference_id: fishReferenceId.trim(),
          fish_model: fishModel,
        },
      });
      showToast("设置已保存到本地数据库");
    } catch {
      showToast("保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTestVoice = async () => {
    voiceAbortRef.current?.abort();
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setTestingVoice(true);
    try {
      await playTaiwanSentences(
        ["欸～嗨啰！我是灵儿啦，这个新的声音你听起来喜欢吗？"],
        {
          provider: ttsProvider,
          voice: selectedVoice,
          rate: voiceRate,
          fish_api_key: fishApiKey.trim(),
          fish_reference_id: fishReferenceId.trim(),
          fish_model: fishModel,
          throwOnError: true,
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        showToast(err instanceof Error ? err.message : "试听语音失败");
      }
    } finally {
      setTestingVoice(false);
    }
  };

  const handleCustomImageUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAvatarConfig({
          provider: "custom-image",
          customImageMap: { idle: reader.result },
        });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)] relative">
      {/* 顶部 52px 极简栏 */}
      <header className="h-[52px] px-4 flex items-center shrink-0 select-none">
        <div className="flex items-center gap-2">

          <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)] px-1">
            设置
          </span>
        </div>
      </header>

      {/* 主体：ChatGPT Desktop 经典双栏设置结构 */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 pb-12 pt-3">
        <div className="max-w-[920px] mx-auto flex flex-col gap-6 md:gap-8 items-start">
          {/* 左侧设置子导航 */}
          <nav className="w-full shrink-0 flex flex-wrap gap-1 overflow-x-auto no-scrollbar pb-1 md:pb-0 ">
            {SECTIONS.map((s) => {
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13.5px] transition-colors shrink-0 cursor-pointer ${
                    active
                      ? "bg-[var(--bg-active)] text-[var(--text-primary)] font-medium"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span
                    className={
                      active
                        ? "text-[var(--text-primary)]"
                        : "text-[var(--text-tertiary)]"
                    }
                  >
                    {s.icon}
                  </span>
                  <span>{s.label}</span>
                </button>
              );
            })}
          </nav>

          {/* 右侧聚焦设置内容区 */}
          <div className="flex-1 min-w-0 w-full animate-fade-up" key={section}>
            {/* 1. 大脑与语音 */}
            {section === "general" && (
              <form onSubmit={handleSaveSettings} className="l-settings-grid">
                <div className="l-settings-head flex items-center justify-between pb-4 border-b border-[var(--border-subtle)]">
                  <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
                    大脑与语音
                  </h3>
                  <button
                    type="submit"
                    disabled={saving}
                    className="h-8 px-4 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-40 text-[var(--ink-primary-fg)] text-[12.5px] font-medium transition-colors cursor-pointer shrink-0"
                  >
                    {saving ? "保存中..." : "保存设置"}
                  </button>
                </div>

                <section className="l-card space-y-4"><h2>通用与模型</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="space-y-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                      小管家昵称
                    </span>
                    <input
                      type="text"
                      value={botName}
                      onChange={(e) => setBotName(e.target.value)}
                      className="w-full h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] text-[var(--text-primary)] outline-none transition-colors"
                    />
                  </label>

                  <div className="space-y-1.5 relative" ref={modelMenuRef}>
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                      模型名称（Model）
                    </span>
                    {(() => {
                      const activePreset = !isCustomModel
                        ? MODEL_PRESET_MAP[model]
                        : undefined;
                      const isCustomActive = !activePreset;
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => setModelMenuOpen((v) => !v)}
                            className={`w-full h-9 px-3 rounded-xl flex items-center justify-between gap-2 text-[13px] transition-all cursor-pointer border ${
                              modelMenuOpen
                                ? "bg-[var(--bg-canvas)] border-[var(--border-strong)] shadow-xs"
                                : "bg-[var(--bg-subtle)] border-transparent hover:bg-[var(--bg-hover)]"
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              {activePreset ? (
                                <>
                                  <span
                                    className={`w-2 h-2 rounded-full shrink-0 ${activePreset.dotClass}`}
                                  />
                                  <span className="truncate font-medium text-[var(--text-primary)]">
                                    {activePreset.label}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="w-2 h-2 rounded-full shrink-0 bg-[var(--text-tertiary)]" />
                                  <span className="truncate text-[var(--text-primary)]">
                                    {model.trim()
                                      ? `自定义 · ${model.trim()}`
                                      : "自定义输入"}
                                  </span>
                                </>
                              )}
                            </span>
                            <IconChevronDown
                              className={`w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0 transition-transform duration-150 ${
                                modelMenuOpen ? "rotate-180" : ""
                              }`}
                            />
                          </button>

                          {modelMenuOpen && (
                            <div
                              className="absolute left-0 right-0 top-full mt-1.5 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] z-40 animate-popover overflow-hidden"
                              style={{ boxShadow: "var(--popover-shadow)" }}
                            >
                              {/* 置顶：自定义输入入口 */}
                              <div className="p-1.5 border-b border-[var(--border-subtle)]">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsCustomModel(true);
                                    setModelMenuOpen(false);
                                    requestAnimationFrame(() => {
                                      customModelInputRef.current?.focus();
                                      customModelInputRef.current?.select();
                                    });
                                  }}
                                  className={`w-full px-2.5 py-2 rounded-xl flex items-center justify-between gap-2 text-left transition-colors cursor-pointer ${
                                    isCustomActive
                                      ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                                      : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                                  }`}
                                >
                                  <span className="flex items-center gap-2.5 min-w-0">
                                    <span className="w-6 h-6 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0 text-[var(--text-secondary)]">
                                      <IconPlus className="w-3.5 h-3.5" />
                                    </span>
                                    <span className="min-w-0">
                                      <span className="block text-[13px] font-medium leading-tight">
                                        自定义输入
                                      </span>
                                      <span className="block text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">
                                        手动填写任意模型名称
                                      </span>
                                    </span>
                                  </span>
                                  {isCustomActive && (
                                    <IconCheck className="w-3.5 h-3.5 text-[var(--text-primary)] shrink-0" />
                                  )}
                                </button>
                              </div>

                              {/* 分组预设模型列表 */}
                              <div className="max-h-[296px] overflow-y-auto p-1.5 space-y-2">
                                {LLM_MODEL_GROUPS.map((group) => (
                                  <div key={group.provider} className="space-y-0.5">
                                    <div className="px-2.5 pt-1 pb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-tertiary)] select-none">
                                      <span
                                        className={`w-1.5 h-1.5 rounded-full ${group.dotClass}`}
                                      />
                                      <span>{group.provider}</span>
                                    </div>
                                    {group.models.map((item) => {
                                      const selected =
                                        !isCustomModel && model === item.id;
                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          onClick={() => {
                                            setIsCustomModel(false);
                                            setModel(item.id);
                                            setBaseUrl(item.baseUrl);
                                            setModelMenuOpen(false);
                                          }}
                                          className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between gap-2 text-[13px] transition-colors cursor-pointer ${
                                            selected
                                              ? "bg-[var(--bg-active)] text-[var(--text-primary)] font-medium"
                                              : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                          }`}
                                        >
                                          <span className="truncate">
                                            {item.label}
                                          </span>
                                          {selected && (
                                            <IconCheck className="w-3.5 h-3.5 text-[var(--text-primary)] shrink-0" />
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {(isCustomModel || !MODEL_BASE_URL_MAP[model]) && (
                    <label className="space-y-1.5 sm:col-span-2">
                      <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                        自定义模型名称
                      </span>
                      <input
                        ref={customModelInputRef}
                        type="text"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="输入任意 OpenAI 兼容模型 ID，如 qwen-plus / local-model"
                        className="w-full h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] font-mono text-[var(--text-primary)] outline-none transition-colors"
                      />
                    </label>
                  )}

                  <div className="space-y-1.5 sm:col-span-2">
                    <div className="flex items-center justify-between gap-2 text-[12.5px] font-medium text-[var(--text-secondary)]">
                      <label htmlFor="llm-base-url">
                        OpenAI 兼容接口地址（Base URL）
                      </label>
                      {!isCustomModel &&
                        MODEL_BASE_URL_MAP[model] &&
                        baseUrl.trim() !== MODEL_BASE_URL_MAP[model] && (
                          <button
                            type="button"
                            onClick={() =>
                              setBaseUrl(MODEL_BASE_URL_MAP[model])
                            }
                            className="text-[11.5px] font-normal text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                          >
                            恢复默认地址
                          </button>
                        )}
                    </div>
                    <input
                      id="llm-base-url"
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="选择预设模型自动填充，也可自定义输入中转/本地地址"
                      className="w-full h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] font-mono text-[var(--text-primary)] outline-none transition-colors"
                    />
                  </div>

                  <label className="space-y-1.5 sm:col-span-2">
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                      API Key（留空时自动启用本地离线演示模式）
                    </span>
                    <div className="relative">
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="输入 Gemini / DeepSeek / 硅基流动 API Key"
                        className="w-full h-9 pl-3 pr-10 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] font-mono text-[var(--text-primary)] outline-none transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        title={showApiKey ? "隐藏 Key" : "显示 Key"}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                      >
                        {showApiKey ? (
                          <IconEyeOff className="w-4 h-4" />
                        ) : (
                          <IconEye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </label>
                </div>

                {/* 语音合成引擎选择与试听 */}
                <button type="button" className="l-pill" disabled={probing || !apiKey.trim() || !model.trim()} onClick={async()=>{
                  setProbing(true);
                  try { await api.testModel(model.trim(),baseUrl.trim(),apiKey.trim());showToast("模型已响应") }
                  catch(e){showToast(String(e))} finally {setProbing(false)}
                }}>{probing?"正在测试…":"测试模型连接"}</button>
                </section><div className="l-card space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] font-medium text-[var(--text-primary)]">
                        语音合成引擎
                      </div>
                      <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                        {ttsProvider === "fish_audio"
                          ? "使用 Fish Audio 高情感自定义/收藏音色（支持按量计费与免费体验档）"
                          : "使用微软免费 Edge-TTS 神经语音"}
                      </div>
                    </div>

                    <div className="inline-flex p-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
                      <button
                        type="button"
                        onClick={() => setTtsProvider("edge_tts")}
                        className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors cursor-pointer ${
                          ttsProvider === "edge_tts"
                            ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        Edge-TTS
                      </button>
                      <button
                        type="button"
                        onClick={() => setTtsProvider("fish_audio")}
                        className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors cursor-pointer ${
                          ttsProvider === "fish_audio"
                            ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        Fish Audio
                      </button>
                    </div>
                  </div>

                  {ttsProvider === "fish_audio" ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <label className="space-y-1.5 sm:col-span-2">
                        <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                          Fish Audio API Key
                        </span>
                        <div className="relative">
                          <input
                            type={showFishApiKey ? "text" : "password"}
                            value={fishApiKey}
                            onChange={(e) => setFishApiKey(e.target.value)}
                            placeholder="sk-fish-..."
                            className="w-full h-9 pl-3 pr-10 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] font-mono text-[var(--text-primary)] outline-none transition-colors"
                          />
                          <button
                            type="button"
                            onClick={() => setShowFishApiKey((v) => !v)}
                            title={showFishApiKey ? "隐藏 Key" : "显示 Key"}
                            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                          >
                            {showFishApiKey ? (
                              <IconEyeOff className="w-4 h-4" />
                            ) : (
                              <IconEye className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </label>

                      <label className="space-y-1.5 sm:col-span-2">
                        <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                          收藏声音 ID（reference_id）
                        </span>
                        <input
                          type="text"
                          value={fishReferenceId}
                          onChange={(e) => setFishReferenceId(e.target.value)}
                          placeholder="粘贴 Fish Audio 音色页 URL 末尾的 32 位 ID"
                          className="w-full h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] font-mono text-[var(--text-primary)] outline-none transition-colors"
                        />
                      </label>

                      <label className="space-y-1.5">
                        <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                          语音模型版本
                        </span>
                        <select
                          value={fishModel}
                          onChange={(e) => setFishModel(e.target.value)}
                          className="w-full h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] text-[13px] text-[var(--text-primary)] outline-none"
                        >
                          {fishModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="flex items-end">
                        <button
                          type="button"
                          disabled={testingVoice || !fishApiKey.trim()}
                          onClick={() => void handleTestVoice()}
                          className="w-full h-9 px-4 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] disabled:opacity-40 text-[12.5px] font-medium text-[var(--text-primary)] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <IconVolumeOn className="w-4 h-4" />
                          <span>
                            {testingVoice ? "合成试听中..." : "试听收藏声音"}
                          </span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                      <label className="space-y-1.5 sm:col-span-2">
                        <span className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
                          神经音色（Microsoft edge-tts）
                        </span>
                        <select
                          value={selectedVoice}
                          onChange={(e) => setSelectedVoice(e.target.value)}
                          className="w-full h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] text-[13px] text-[var(--text-primary)] outline-none"
                        >
                          {voices.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.style ? `${v.name} — ${v.style}` : v.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={testingVoice}
                        onClick={() => void handleTestVoice()}
                        className="h-9 px-4 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[12.5px] font-medium text-[var(--text-primary)] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <IconVolumeOn className="w-4 h-4" />
                        <span>{testingVoice ? "试听中..." : "试听声音"}</span>
                      </button>
                    </div>
                  )}

                  {/* 通用朗读语速调节（同时支持 Fish Audio 与 Edge-TTS） */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                      朗读语速
                    </span>
                    <div className="inline-flex p-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
                      {(
                        [
                          ["-20%", "0.8x"],
                          ["+0%", "1.0x"],
                          ["+25%", "1.25x"],
                          ["+50%", "1.5x"],
                          ["+100%", "2.0x"],
                        ] as const
                      ).map(([val, label]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setVoiceRate(val)}
                          className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium tabular-nums transition-colors cursor-pointer ${
                            voiceRate === val
                              ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 本地离线 ASR 状态提示条 */}
                  {sttStatus && (
                    <div className="p-4 rounded-xl bg-[var(--bg-subtle)]/70 border border-[var(--border-subtle)] text-[12px] space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[var(--text-primary)]">
                          本地离线语音识别（sherpa-onnx ASR）
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            sttStatus.ready
                              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                              : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
                          }`}
                        >
                          {sttStatus.ready ? "已就绪" : "待配置离线模型"}
                        </span>
                      </div>
                      <p className="text-[var(--text-secondary)]">
                        {sttStatus.message}
                      </p>
                      {sttStatus.setup_hints?.map((hint) => (
                        <p
                          key={hint}
                          className="text-[11.5px] text-[var(--text-tertiary)] font-mono break-all"
                        >
                          • {hint}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </form>
            )}

            {/* 2. 全天作息与主动陪伴 */}
            {section === "schedule" && <ScheduleCard onToast={showToast} />}

            {/* 3. 纯本地离线语音唤醒与开机自启 */}
            {section === "wakeword" && <WakewordCard onToast={showToast} />}

            {/* 4. 灵儿桌宠形象、核心 6 表情验证与全情绪表情盘 */}
            {section === "avatar" && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--border-subtle)]">
                  <div>
                    <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
                      灵儿桌宠形象与表情盘
                    </h3>
                    <p className="text-[12.5px] text-[var(--text-tertiary)] mt-0.5">
                      保留 3D 公仔正面原貌与左深右浅晶体蓝眼；点选任意情绪实时同步到桌面浮窗
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setAvatarConfig({ provider: "builtin-sprite" })
                      }
                      className={`h-8 px-3 rounded-full text-[12px] font-medium transition-colors cursor-pointer ${
                        avatarConfig.provider === "builtin-sprite"
                          ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                          : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      灵儿 3D 分层
                    </button>
                    <label
                      className={`h-8 px-3 rounded-full text-[12px] font-medium flex items-center transition-colors cursor-pointer ${
                        avatarConfig.provider === "custom-image"
                          ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                          : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      自定义换图
                      <input
                        type="file"
                        accept="image/png,image/gif,image/webp,image/jpeg"
                        onChange={handleCustomImageUpload}
                        className="hidden"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setAvatarConfig({
                          provider: "live2d",
                          live2dModelPath: "models/linger/linger.model3.json",
                        })
                      }
                      className={`h-8 px-3 rounded-full text-[12px] font-medium transition-colors cursor-pointer ${
                        avatarConfig.provider === "live2d"
                          ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                          : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      Live2D 预留
                    </button>
                  </div>
                </div>

                {/* 核心 6 表情真实桌宠尺寸并排对照区 */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                        核心 6 表情对照（真实桌宠尺寸）
                      </div>
                      <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                        待机 · 开心 · 好奇 · 委屈 · 害羞 · 受惊 — 检验小尺寸下「害羞 vs 委屈」「好奇 vs 受惊」辨识度
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCleanValidation((v) => !v)}
                      className={`h-7 px-3 rounded-full text-[11.5px] font-medium transition-colors cursor-pointer ${
                        cleanValidation
                          ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                          : "bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                      }`}
                    >
                      {cleanValidation ? "纯净模式：仅看脸与动作" : "显示文字标签"}
                    </button>
                  </div>

                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                    {CORE_SIX_EMOTIONS.map((emo) => {
                      const active = previewEmotion === emo;
                      return (
                        <button
                          key={emo}
                          type="button"
                          onClick={() => {
                            setPreviewEmotion(emo);
                            window.taiwanBotEnv?.sendPetPreviewState({
                              emotion: emo,
                              bubble: PET_EMOTION_META[emo].sampleBubble,
                            });
                          }}
                          className={`group flex flex-col items-center justify-center rounded-xl p-2 border transition-all cursor-pointer ${
                            active
                              ? "border-[var(--ink-primary)] bg-[var(--bg-active)] shadow-sm"
                              : "border-[var(--border-subtle)] bg-[var(--bg-subtle)]/60 hover:bg-[var(--bg-subtle)]"
                          }`}
                        >
                          <AvatarRenderer
                            emotion={emo}
                            config={avatarConfig}
                            size={112}
                            cleanMode={cleanValidation}
                            staticFrame={previewEmotion !== emo}
                          />
                          {!cleanValidation && (
                            <span className="mt-1.5 text-[11.5px] font-medium text-[var(--text-secondary)]">
                              {PET_EMOTION_META[emo].label}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 实时互动舞台（支持按住摸头三段式测试 + 同步桌宠） */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 flex flex-col sm:flex-row items-center gap-6">
                  <div className="w-44 h-44 rounded-2xl bg-gradient-to-b from-sky-50/80 to-indigo-50/70 dark:from-slate-800/80 dark:to-slate-900/80 border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                    <AvatarRenderer
                      emotion={previewEmotion}
                      config={avatarConfig}
                      size={160}
                      isPatting={previewPatting}
                      patMood={previewPatMood}
                      cleanMode={cleanValidation}
                      svgRef={previewSvgRef}
                    />
                  </div>
                  <div className="space-y-3 flex-1 w-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                        当前预览：{PET_EMOTION_META[previewEmotion].label}
                      </span>
                      <span className="text-[11.5px] px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-tertiary)]">
                        {PET_EMOTION_META[previewEmotion].group}
                      </span>
                    </div>
                    <p className="text-[12.5px] text-[var(--text-secondary)]">
                      “{PET_EMOTION_META[previewEmotion].sampleBubble}”
                    </p>

                    {/* 摸头三段式交互测试条 */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onPointerDown={() => setPreviewPatting(true)}
                        onPointerUp={() => setPreviewPatting(false)}
                        onPointerLeave={() => setPreviewPatting(false)}
                        onPointerCancel={() => setPreviewPatting(false)}
                        className={`h-8 px-3.5 rounded-full text-[12px] font-medium transition-all cursor-pointer select-none ${
                          previewPatting
                            ? "bg-sky-500 text-white scale-[0.98]"
                            : "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)] hover:opacity-90"
                        }`}
                      >
                        {previewPatting ? "正在摸头（保持中…松手回落）" : "按住测试摸头（进入→保持→回落）"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewPatMood((m) => (m === "shy" ? "happy" : "shy"))
                        }
                        className="h-8 px-3 rounded-full text-[12px] font-medium bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        摸头反应：{previewPatMood === "shy" ? "害羞躲视线" : "开心眯眼笑"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewEmotion("sleepy");
                          window.taiwanBotEnv?.sendPetPreviewState({
                            emotion: "sleepy",
                            bubble: PET_EMOTION_META.sleepy.sampleBubble,
                          });
                        }}
                        className="h-8 px-3 rounded-full text-[12px] font-medium bg-sky-500/15 text-sky-600 dark:text-sky-300 hover:bg-sky-500/25 cursor-pointer"
                      >
                        拿出枕头睡觉
                      </button>
                    </div>
                    <div className="text-[11.5px] text-[var(--text-tertiary)]">
                      桌面浮窗交互：轻抚头顶→摸头害羞/开心 · 单击→好奇看你 · 拖起→受惊 / 放下→松一口气 · 久置→无聊→困倦
                    </div>
                  </div>
                </div>

                {/* 完整 12 组情绪手动表情盘 */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 space-y-3.5">
                  <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                    全情绪手动表情盘（12 组日常交流全覆盖）
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {EMOTION_GROUPS.map((grp) => (
                      <div
                        key={grp.id}
                        className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-3 space-y-2"
                      >
                        <div className="text-[11.5px] font-medium text-[var(--text-tertiary)]">
                          {grp.title}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {grp.emotions.map((emo) => (
                            <button
                              key={emo}
                              type="button"
                              onClick={() => {
                                setPreviewEmotion(emo);
                                window.taiwanBotEnv?.sendPetPreviewState({
                                  emotion: emo,
                                  bubble: PET_EMOTION_META[emo].sampleBubble,
                                });
                              }}
                              className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors cursor-pointer ${
                                previewEmotion === emo
                                  ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                                  : "bg-[var(--bg-surface)] hover:bg-[var(--bg-active)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]"
                              }`}
                            >
                              {PET_EMOTION_META[emo].label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}


          </div>
        </div>
      </div>

      {/* 底部居中悬浮轻提示 Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full bg-[var(--ink-primary)] text-[var(--ink-primary-fg)] text-[12.5px] font-medium shadow-lg animate-fade-up">
          {toast}
        </div>
      )}
    </div>
  );
}
