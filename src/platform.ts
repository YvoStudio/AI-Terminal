export type Platform = 'windows' | 'macos' | 'linux';

export const platform: Platform = (() => {
  const ua = navigator.userAgent;
  if (ua.includes('Mac')) return 'macos';
  if (ua.includes('Windows')) return 'windows';
  return 'linux';
})();

export const isMac = platform === 'macos';
export const isWindows = platform === 'windows';
export const isLinux = platform === 'linux';

export const platformConfig = {
  font: {
    mono: isMac ? "'SF Mono', 'Menlo', monospace" : isWindows ? "'Consolas', monospace" : "'Cascadia Code', 'Ubuntu Mono', monospace",
    chinese: isWindows ? "'SimHei', 'Microsoft YaHei', sans-serif" : isMac ? "system-ui, 'PingFang SC', sans-serif" : "'Noto Sans CJK SC', 'WenQuanYi Zen Hei', sans-serif",
  },
  fontSize: isWindows ? 15 : 13,
  titleBar: isMac ? 'native' : 'custom' as const,
  shells: isWindows ? ['cmd', 'powershell', 'wsl'] : ['bash'],
} as const;

export function getPlatformFonts(): { mono: string; chinese: string } {
  return platformConfig.font;
}

export function getDefaultFontSize(): number {
  return platformConfig.fontSize;
}

export function shouldUseNativeTitleBar(): boolean {
  return isMac;
}

export function getAvailableShells(): string[] {
  return platformConfig.shells;
}