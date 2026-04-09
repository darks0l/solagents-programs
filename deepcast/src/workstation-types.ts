export type WorkstationTheme = "terminal" | "modern" | "cyberpunk";

export interface ExecutionStep {
  /** Step label shown in progress indicator */
  label: string;
  /** Command executed (shown in terminal) */
  command?: string;
  /** stdout/stderr output */
  output?: string;
  /** Files created or modified */
  files?: string[];
  /** Files deleted */
  deletedFiles?: string[];
  /** LLM reasoning shown in sidebar */
  reasoning?: string;
  /** Animation duration in ms (auto-calculated if omitted) */
  duration?: number;
}

export interface WorkstationScript {
  title: string;
  subtitle?: string;
  theme?: WorkstationTheme;
  fps?: number;
  resolution?: { width: number; height: number };
  steps: ExecutionStep[];
  /** Optional end card title */
  endTitle?: string;
  endSubtitle?: string;
}

export interface RenderOptions {
  script: WorkstationScript;
  outputPath: string;
}

// Theme color palettes
export const THEMES = {
  terminal: {
    bg: "#0d1117",
    windowBg: "#161b22",
    windowBorder: "#30363d",
    accent: "#58a6ff",
    text: "#c9d1d9",
    dimText: "#8b949e",
    prompt: "#3fb950",
    error: "#f85149",
    fileAdd: "#3fb950",
    fileDel: "#f85149",
    fileEdit: "#d29922",
    cursor: "#c9d1d9",
    glow: "rgba(88,166,255,0.15)",
    font: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
  },
  modern: {
    bg: "#1a1a2e",
    windowBg: "#16213e",
    windowBorder: "#0f3460",
    accent: "#e94560",
    text: "#eaeaea",
    dimText: "#7f8c8d",
    prompt: "#00d4ff",
    error: "#ff6b6b",
    fileAdd: "#00d4ff",
    fileDel: "#ff6b6b",
    fileEdit: "#feca57",
    cursor: "#ffffff",
    glow: "rgba(233,69,96,0.15)",
    font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: 14,
  },
  cyberpunk: {
    bg: "#0a0010",
    windowBg: "#12001f",
    windowBorder: "#9d00ff",
    accent: "#ff00ff",
    text: "#ff00ff",
    dimText: "#7b00a0",
    prompt: "#00ffff",
    error: "#ff3366",
    fileAdd: "#00ff88",
    fileDel: "#ff3366",
    fileEdit: "#ffff00",
    cursor: "#ff00ff",
    glow: "rgba(255,0,255,0.2)",
    font: "'Courier New', Courier, monospace",
    fontSize: 13,
  },
} as const;
