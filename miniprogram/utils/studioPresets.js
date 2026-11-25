/**
 * Hy-Image 3.5 工作台预设常量与尺寸校验工具
 */

const SIZE_PRESETS = {
  '1:1': { 1: '1024x1024', 1.5: '1536x1536', 2: '2048x2048', 4: '4096x4096' },
  '4:3': { 1: '1152x864', 1.5: '1600x1200', 2: '2304x1728', 4: '3200x2400' },
  '3:4': { 1: '864x1152', 1.5: '1200x1600', 2: '1728x2304', 4: '2400x3200' },
  '16:9': { 1: '1344x768', 1.5: '1920x1080', 2: '2560x1440', 4: '3840x2160' },
  '9:16': { 1: '768x1344', 1.5: '1080x1920', 2: '1440x2560', 4: '2160x3840' },
};

const MAX_PIXELS_PRESETS = {
  1: 1048576,
  1.5: 2359296,
  2: 4194304,
};

const STYLE_TAGS = [
  { label: '🎬 电影光影', tag: '电影级景深光影，8k超清，masterpiece' },
  { label: '🌸 唯美东方', tag: '东方美学极致写实，细腻发丝与衣袂飘动' },
  { label: '🌆 赛博朋克', tag: '赛博朋克霓虹夜景，雨夜水洼光影倒影' },
  { label: '🦚 景泰蓝国潮', tag: '非遗景泰蓝掐丝珐琅工艺，微距特写，金丝流光' },
  { label: '🖌️ 水墨国画', tag: '水墨意境留白，淡雅诗意，写意山水' },
  { label: '🧸 3D萌系', tag: '可爱3D皮克斯动画风格，毛茸茸质感，柔和暖光' },
];

const SAMPLE_PROMPTS = [
  '9:16 竖版，极致武侠风，绝美东方女侠，冷艳锐利丹凤眼，深黑改良劲装，外披宽袖玄色长袍，手持幽蓝光芒古剑，月夜雨雾竹林古道，电影级光影，8k，masterpiece',
  '一只戴着炫彩墨镜的金毛犬在蔚蓝海浪中冲浪，水花四溅，明媚阳光逆光，高精写实毛发细节，8k摄影',
  '16:9 宽屏，赛博朋克风格未来东方立体都市，霓虹雨夜，水洼倒影，穿梭飞车，超强景深，电影大片感',
  '非遗景泰蓝掐丝珐琅工艺的机械飞鸟，金丝流光，微距特写摄影，釉色温润，国潮神韵',
  '水墨江南水乡晨雾微曦，乌篷船划破如镜水面，粉墙黛瓦，留白诗意，当代写意国画',
];

const RATIOS = [
  { value: 'auto', label: '✨ 自动', desc: '模型智能决定（默认）' },
  { value: '1:1', label: '1:1', desc: '方图头像' },
  { value: '4:3', label: '4:3', desc: '横版插画' },
  { value: '3:4', label: '3:4', desc: '竖版海报' },
  { value: '16:9', label: '16:9', desc: '宽屏壁纸' },
  { value: '9:16', label: '9:16', desc: '手机竖屏' },
  { value: 'custom', label: '自定义', desc: '自由宽高' },
];

const MULTIPLIERS = [
  { value: 'auto', label: '自动' },
  { value: 1, label: '1K' },
  { value: 1.5, label: '1.5K' },
  { value: 2, label: '2K' },
  { value: 4, label: '4K' },
];

const LOADING_STAGES = [
  '正在解析提示词与美学构图...',
  '混元 3.5 扩散去噪演算中...',
  '正在渲染高清纹理与光影层次...',
  '精细化主体与边缘细节刻画...',
  '处理水印设置，即将交付出图...',
];

function createSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 根据画幅比例、清晰度档位与自定义宽高计算发送参数及界面文案
 */
function resolveSizeSpec({ selectedRatio, selectedMultiplier, customWidth, customHeight }) {
  if (selectedRatio === 'auto') {
    if (selectedMultiplier === 'auto') {
      return {
        currentSize: '',
        currentMaxPixels: 0,
        currentSizeLabel: '自动 (模型智能匹配)',
      };
    }
    const maxPixels = MAX_PIXELS_PRESETS[selectedMultiplier] || 0;
    return {
      currentSize: '',
      currentMaxPixels: maxPixels,
      currentSizeLabel: `自动比例 · ${selectedMultiplier}K 档`,
    };
  }

  if (selectedRatio === 'custom') {
    const w = parseInt(customWidth, 10) || 1024;
    const h = parseInt(customHeight, 10) || 1024;
    const size = `${w}x${h}`;
    return {
      currentSize: size,
      currentMaxPixels: 0,
      currentSizeLabel: `自定义 (${size})`,
    };
  }

  const effectiveMultiplier = selectedMultiplier === 'auto' ? 1.5 : selectedMultiplier;
  const preset = SIZE_PRESETS[selectedRatio];
  const size = (preset && preset[effectiveMultiplier]) || '1024x1024';
  const multLabel =
    selectedMultiplier === 'auto'
      ? '自动·1.5K'
      : effectiveMultiplier === 4
        ? '4K'
        : `${effectiveMultiplier}K`;

  return {
    currentSize: size,
    currentMaxPixels: 0,
    currentSizeLabel: `${selectedRatio} (${size}) [${multLabel}]`,
  };
}

/**
 * 校验自定义/预设像素尺寸合法性
 */
function validatePixelSize(sizeStr) {
  if (!sizeStr) {
    return { valid: true, width: 0, height: 0, errorMessage: '' };
  }
  const [w, h] = sizeStr.split('x').map((n) => parseInt(n, 10));
  if (!w || !h || w < 256 || w > 8192 || h < 256 || h > 8192) {
    return { valid: false, width: w || 0, height: h || 0, errorMessage: '单边像素需在 256 ~ 8192 之间' };
  }
  if (w * h > 4096 * 4096) {
    return { valid: false, width: w, height: h, errorMessage: '总像素面积不可超过 4096×4096' };
  }
  return { valid: true, width: w, height: h, errorMessage: '' };
}

module.exports = {
  SIZE_PRESETS,
  MAX_PIXELS_PRESETS,
  STYLE_TAGS,
  SAMPLE_PROMPTS,
  RATIOS,
  MULTIPLIERS,
  LOADING_STAGES,
  createSessionId,
  resolveSizeSpec,
  validatePixelSize,
};
