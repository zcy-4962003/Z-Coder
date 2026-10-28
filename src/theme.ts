// 统一主题：所有界面颜色都从这里取
// - Ink 组件直接使用 hex（Ink 会按终端能力自动降级）
// - 纯字符串输出（markdown、diff、-p 模式）使用 fg()/bg() 生成 ANSI 转义序列

export const theme = {
  /** 品牌主色：薰衣草紫（Logo、助手标记、加载动画、选中项） */
  brand: '#B4A0FF',
  /** 较深的紫：边框、次要强调 */
  brandDeep: '#8B7BD8',
  /** 较浅的紫：行内代码、提示信息 */
  brandLight: '#D4C8FF',
  /** 次要文字 */
  muted: '#8A8698',
  /** 边框、分隔线 */
  subtle: '#5A566A',
  success: '#7FD1A0',
  warning: '#E8C17A',
  error: '#F28B9B',
  link: '#8FB8F5',
  /** diff 背景 */
  diffAddBg: '#1F3B2C',
  diffDelBg: '#45212C',
  /** 代码高亮 */
  code: {
    keyword: '#C3A6FF',
    string: '#9FD9A8',
    number: '#F0C08A',
    comment: '#6E6A80',
  },
} as const;

// ------------------------------------------------------------------ ANSI 输出

type Level = 0 | 1 | 2 | 3;

function detectLevel(): Level {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return 0;
  const out = process.stdout as typeof process.stdout & { hasColors?: (n: number) => boolean };
  if (out.hasColors?.(2 ** 24)) return 3;
  if (out.hasColors?.(256)) return 2;
  return 1;
}

export const colorLevel: Level = detectLevel();

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function to256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** 16 色终端下的近似色 */
function to16([r, g, b]: [number, number, number], isBg: boolean): number {
  const max = Math.max(r, g, b);
  if (max < 70) return isBg ? 40 : 90;
  const code = (Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255);
  return (isBg ? 40 : 30) + (code || 7);
}

function sgr(hex: string, isBg: boolean): string {
  const c = rgb(hex);
  if (colorLevel === 3) return `${isBg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}`;
  if (colorLevel === 2) return `${isBg ? 48 : 38};5;${to256(c)}`;
  return String(to16(c, isBg));
}

export function fg(hex: string): (s: string) => string {
  if (!colorLevel) return (s) => s;
  const open = `\x1b[${sgr(hex, false)}m`;
  // 内部若有其它前景色的结束符（39），结束后恢复本色，保证嵌套正确
  return (s) => open + s.replace(/\x1b\[39m/g, '\x1b[39m' + open) + '\x1b[39m';
}

export function bg(hex: string): (s: string) => string {
  if (!colorLevel) return (s) => s;
  const open = `\x1b[${sgr(hex, true)}m`;
  return (s) => open + s.replace(/\x1b\[49m/g, '\x1b[49m' + open) + '\x1b[49m';
}

// ------------------------------------------------------------------ Logo

/**
 * 像素小章鱼（半格字符，3 行 × 9 列，对应 6 × 9 的像素图）
 *   头部 → 两只眼睛 → 两侧触手外卷、中间两根垂下
 */
export const OCTOPUS = [' ▄█████▄ ', ' ██▄█▄██ ', '▄▀ █ █ ▀▄'];
