import { ITheme } from '@xterm/xterm';

export interface TerminalTheme {
  name: string;
  theme: ITheme;
  uiBg: string;
  light?: boolean;
}

export const themes: TerminalTheme[] = [
  {
    name: 'Pure Black',
    uiBg: '#000000',
    theme: {
      background: '#000000', foreground: '#ffffff', cursor: '#ffffff',
      cursorAccent: '#000000', selectionBackground: 'rgba(81,139,255,0.45)',
      black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#6699ff', magenta: '#ff79c6', cyan: '#8be9fd', white: '#ffffff',
      brightBlack: '#555555', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#99bbff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Pure White',
    uiBg: '#ffffff',
    light: true,
    theme: {
      background: '#ffffff', foreground: '#333333', cursor: '#000000',
      cursorAccent: '#ffffff', selectionBackground: 'rgba(51,120,220,0.35)',
      black: '#000000', red: '#c41a16', green: '#007400', yellow: '#826b28',
      blue: '#0451a5', magenta: '#a626a4', cyan: '#0598bc', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#e45649', brightGreen: '#50a14f',
      brightYellow: '#c18401', brightBlue: '#4078f2', brightMagenta: '#a626a4',
      brightCyan: '#0184bc', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Cream',
    uiBg: '#fdf6e3',
    light: true,
    theme: {
      background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75',
      cursorAccent: '#fdf6e3', selectionBackground: 'rgba(51,120,220,0.30)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#657b83', brightRed: '#cb4b16', brightGreen: '#859900',
      brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    name: 'Catppuccin',
    uiBg: '#1e1e2e',
    theme: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e', selectionBackground: 'rgba(81,139,255,0.40)',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
  {
    name: 'Deep Teal',
    uiBg: '#065f6a',
    theme: {
      background: '#065f6a', foreground: '#ffffff', cursor: '#ffffff',
      cursorAccent: '#065f6a', selectionBackground: 'rgba(255,255,255,0.25)',
      black: '#000000', red: '#ff6b6b', green: '#69db7c', yellow: '#ffd43b',
      blue: '#74c0fc', magenta: '#da77f2', cyan: '#66d9e8', white: '#e0f2f1',
      brightBlack: '#4a9da8', brightRed: '#ff8787', brightGreen: '#8ce99a',
      brightYellow: '#ffe066', brightBlue: '#a5d8ff', brightMagenta: '#e599f7',
      brightCyan: '#99e9f2', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Dracula',
    uiBg: '#282a36',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
      cursorAccent: '#282a36', selectionBackground: 'rgba(81,139,255,0.40)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Monokai Pro',
    uiBg: '#2d2a2e',
    theme: {
      background: '#2d2a2e', foreground: '#fcfcfa', cursor: '#fcfcfa',
      cursorAccent: '#2d2a2e', selectionBackground: 'rgba(253,151,31,0.25)',
      black: '#403e41', red: '#ff6188', green: '#a9dc76', yellow: '#ffd866',
      blue: '#fc9867', magenta: '#ab9df2', cyan: '#78dce8', white: '#fcfcfa',
      brightBlack: '#727072', brightRed: '#ff6188', brightGreen: '#a9dc76',
      brightYellow: '#ffd866', brightBlue: '#fc9867', brightMagenta: '#ab9df2',
      brightCyan: '#78dce8', brightWhite: '#fcfcfa',
    },
  },
];
