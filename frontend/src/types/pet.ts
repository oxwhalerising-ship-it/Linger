/**
 * 灵儿（Ling'er）桌宠与可插拔形象核心类型定义
 * ---------------------------------------------
 * 统一规范：
 * 1. 保留原有 7 个系统交互状态（兼容后端 WebSocket / 语音通话 / 快捷对话）
 * 2. 扩展覆盖「6 个核心优先表情 + 12 组日常情绪」的完整灵儿表情语言
 * 3. 定义「进入 → 保持 → 回落」三段式交互阶段与可插拔渲染器协议
 */

/** 灵儿支持的全部情绪 / 交互状态 */
export type PetEmotion =
  // === 原有系统核心状态（完全向后兼容后端） ===
  | "idle"        // 待机 / 平静
  | "happy"       // 开心
  | "encouraging" // 暖心鼓励
  | "thinking"    // 思考
  | "speaking"    // 说话中
  | "sleepy"      // 困倦 / 打瞌睡
  | "listening"   // 专注倾听
  // === 核心优先 6 表情其余 4 项 ===
  | "curious"     // 好奇
  | "aggrieved"   // 委屈
  | "shy"         // 害羞
  | "startled"    // 受惊
  // === 12 组日常情绪扩展 ===
  | "relieved"    // 安心 / 放下松一口气
  | "excited"     // 兴奋
  | "laughing"    // 大笑
  | "affectionate"// 喜欢 / 依恋
  | "grateful"    // 感激
  | "confused"    // 困惑
  | "skeptical"   // 怀疑
  | "surprised"   // 惊喜 / 惊讶
  | "sad"         // 难过
  | "angry"       // 生气
  | "dissatisfied"// 不满
  | "worried"     // 担心
  | "nervous"     // 紧张
  | "embarrassed" // 尴尬
  | "guilty"      // 愧疚
  | "disgusted"   // 厌恶 / 抗拒
  | "proud"       // 得意 / 自豪
  | "expectant"   // 期待
  | "bored";      // 无聊

/** 核心优先验证的 6 个表情 */
export const CORE_SIX_EMOTIONS: PetEmotion[] = [
  "idle",
  "happy",
  "curious",
  "aggrieved",
  "shy",
  "startled",
];

/** 12 组情绪分类（用于表情盘手动点选） */
export interface EmotionGroupDef {
  id: string;
  title: string;
  emotions: PetEmotion[];
}

export const EMOTION_GROUPS: EmotionGroupDef[] = [
  { id: "calm", title: "平静 · 安心", emotions: ["idle", "relieved", "listening"] },
  { id: "joy", title: "开心 · 兴奋 · 大笑", emotions: ["happy", "excited", "laughing", "encouraging"] },
  { id: "warm", title: "喜欢 · 感激", emotions: ["affectionate", "grateful"] },
  { id: "curious", title: "好奇 · 困惑 · 怀疑", emotions: ["curious", "confused", "skeptical", "thinking"] },
  { id: "surprise", title: "惊喜 · 受惊", emotions: ["surprised", "startled"] },
  { id: "sad", title: "委屈 · 难过", emotions: ["aggrieved", "sad"] },
  { id: "angry", title: "生气 · 不满", emotions: ["angry", "dissatisfied"] },
  { id: "anxious", title: "担心 · 紧张", emotions: ["worried", "nervous"] },
  { id: "shy", title: "害羞 · 尴尬 · 愧疚", emotions: ["shy", "embarrassed", "guilty"] },
  { id: "reject", title: "厌恶 · 抗拒", emotions: ["disgusted"] },
  { id: "proud", title: "得意 · 期待", emotions: ["proud", "expectant"] },
  { id: "tired", title: "无聊 · 困倦", emotions: ["bored", "sleepy", "speaking"] },
];

/** 桌宠边缘躲藏偷看 / 应用窗口边框倚靠与坐下姿态 */
export type PetDockPose =
  | "none"
  | "peek-left"
  | "peek-right"
  | "peek-top"
  | "lean-left"
  | "lean-right"
  | "sit-top"
  | "sit-bottom";

/** 交互三段式阶段（进入 → 保持 → 回落） */
export type PetInteractionPhase =
  | "none"
  | "pat-enter"
  | "pat-hold"
  | "pat-release"
  | "drag-lift"
  | "drag-drop";

/** 可插拔形象渲染引擎类型 */
export type AvatarProviderType = "builtin-sprite" | "custom-image" | "live2d";

/** 形象渲染器配置 */
export interface AvatarConfig {
  provider: AvatarProviderType;
  /** 自定义图片模式下，可按表情分别指定图片 URL/DataURL，未指定时回退到 idle */
  customImageMap?: Partial<Record<PetEmotion, string>>;
  /** 预留：Live2D 模型配置文件路径（.model3.json） */
  live2dModelPath?: string;
}

/** 全部表情的中文标签、动作特征与示例语境 */
export const PET_EMOTION_META: Record<
  PetEmotion,
  { label: string; group: string; sampleBubble: string }
> = {
  idle: {
    label: "待机平静",
    group: "平静",
    sampleBubble: "欸～我一直都在角落陪你喔，累了记得伸个懒腰啦！",
  },
  relieved: {
    label: "安心松气",
    group: "平静",
    sampleBubble: "呼——安全落地啦，刚刚吓我一跳捏！",
  },
  happy: {
    label: "开心",
    group: "开心",
    sampleBubble: "耶！你今天真的超赞的捏，给你一百个大拇指喔！",
  },
  excited: {
    label: "兴奋",
    group: "开心",
    sampleBubble: "哇哇哇！真的吗！我开心得都要踮起脚尖啦！",
  },
  laughing: {
    label: "大笑",
    group: "开心",
    sampleBubble: "哈哈哈哈太好笑了啦，肚子都要笑痛了捏！",
  },
  encouraging: {
    label: "暖心鼓励",
    group: "开心",
    sampleBubble: "没关系啦～拍拍你喔！慢慢来也很可以，我挺你到底！",
  },
  affectionate: {
    label: "喜欢",
    group: "喜欢",
    sampleBubble: "最喜欢和你待在一起了啦，一直陪着我好不好？",
  },
  grateful: {
    label: "感激",
    group: "喜欢",
    sampleBubble: "谢谢你喔～有你这么照顾我，心里暖暖的！",
  },
  curious: {
    label: "好奇",
    group: "好奇",
    sampleBubble: "咦？你在看什么呀，也凑过来让我瞧瞧嘛～",
  },
  confused: {
    label: "困惑",
    group: "好奇",
    sampleBubble: "嗯……歪头想了半天，好像有点没转过弯来耶？",
  },
  skeptical: {
    label: "怀疑",
    group: "好奇",
    sampleBubble: "真的假的啦……你该不会在逗我玩吧？",
  },
  thinking: {
    label: "思考",
    group: "好奇",
    sampleBubble: "嗯嗯～让我想一下喔，马上帮你整理好！",
  },
  surprised: {
    label: "惊喜",
    group: "惊喜",
    sampleBubble: "哇！居然还有这种好事，眼睛都亮起来啦！",
  },
  startled: {
    label: "受惊",
    group: "惊喜",
    sampleBubble: "呀！突然把我提起来干嘛啦，水晶坠都要飞起来了！",
  },
  aggrieved: {
    label: "委屈",
    group: "委屈",
    sampleBubble: "唔……明明我都很乖的说，干嘛凶人家啦……",
  },
  sad: {
    label: "难过",
    group: "委屈",
    sampleBubble: "心情有点低落……能不能借我靠一下下？",
  },
  angry: {
    label: "生气",
    group: "生气",
    sampleBubble: "哼！这次真的有点生气了喔，不哄好我不理你了！",
  },
  dissatisfied: {
    label: "不满",
    group: "生气",
    sampleBubble: "鼓脸颊——怎么可以这样敷衍人家嘛！",
  },
  worried: {
    label: "担心",
    group: "担心",
    sampleBubble: "你还好吗？别太勉强自己喔，我会担心的……",
  },
  nervous: {
    label: "紧张",
    group: "担心",
    sampleBubble: "手心有点冒汗耶……深呼吸、深呼吸……",
  },
  shy: {
    label: "害羞",
    group: "害羞",
    sampleBubble: "呜……突然摸人家头干嘛啦，脸都热起来了……",
  },
  embarrassed: {
    label: "尴尬",
    group: "害羞",
    sampleBubble: "啊哈哈……刚刚那个可以假装没看见吗……",
  },
  guilty: {
    label: "愧疚",
    group: "害羞",
    sampleBubble: "对不起啦……下次我一定会更小心的……",
  },
  disgusted: {
    label: "抗拒",
    group: "抗拒",
    sampleBubble: "达咩达咩！这个我真的不行，快拿走啦～",
  },
  proud: {
    label: "得意自豪",
    group: "得意",
    sampleBubble: "哼哼～厉害吧！我就知道我一定做得到！",
  },
  expectant: {
    label: "期待",
    group: "得意",
    sampleBubble: "盯——接下来会发生什么有趣的事呀？",
  },
  bored: {
    label: "无聊",
    group: "疲惫",
    sampleBubble: "晃呀晃～好久没动静了，要不要找我聊两句呀？",
  },
  sleepy: {
    label: "困倦",
    group: "疲惫",
    sampleBubble: "呼啊……眼皮有点重了捏，差点点着脑袋睡过去……",
  },
  speaking: {
    label: "说话中",
    group: "互动",
    sampleBubble: "跟你讲喔～喝一口温开水，脑袋会马上清醒很多耶！",
  },
  listening: {
    label: "专注倾听",
    group: "互动",
    sampleBubble: "我在听喔～今天发生什么事都可以跟我讲啦！",
  },
};

/** 单击灵儿时的互动回应（以好奇看你为主） */
export const POKE_RESPONSES: Array<{ emotion: PetEmotion; text: string }> = [
  {
    emotion: "curious",
    text: "咦～点我一下是想找我聊什么呀？",
  },
  {
    emotion: "curious",
    text: "嗯？我在喔！有什么事可以跟我讲啦～",
  },
  {
    emotion: "happy",
    text: "欸嘿～轻轻摸我头的话我会超开心的喔！",
  },
  {
    emotion: "affectionate",
    text: "双击我就可以打开主控面板看今日打卡啦～",
  },
];
