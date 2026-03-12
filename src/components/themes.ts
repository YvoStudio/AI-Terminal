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
      cursorAccent: '#000000', selectionBackground: '#333333',
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
      cursorAccent: '#ffffff', selectionBackground: '#d0d0d0',
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
      cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#657b83', brightRed: '#cb4b16', brightGreen: '#859900',
      brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    name: 'Ocean Blue',
    uiBg: '#3fb8d4',
    light: true,
    theme: {
      background: '#3fb8d4', foreground: '#1a1a1a', cursor: '#000000',
      cursorAccent: '#3fb8d4', selectionBackground: '#2a8fa8',
      black: '#000000', red: '#c41a16', green: '#006400', yellow: '#7a5b00',
      blue: '#003d99', magenta: '#8b008b', cyan: '#005f5f', white: '#e5e5e5',
      brightBlack: '#444444', brightRed: '#d32f2f', brightGreen: '#2e7d32',
      brightYellow: '#9a6e00', brightBlue: '#1565c0', brightMagenta: '#9c27b0',
      brightCyan: '#00796b', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Catppuccin',
    uiBg: '#1e1e2e',
    theme: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e', selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
];
