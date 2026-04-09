import { WorkstationScript, THEMES, WorkstationTheme, THEMES as ThemePalettes } from "./workstation-types.js";
import { validateFFmpeg } from "./renderer.js";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renderWorkstation(
  script: WorkstationScript,
  outputPath: string
): Promise<{ duration: number; fileSize: number }> {
  const themeName: WorkstationTheme = script.theme ?? "terminal";
  const theme: typeof ThemePalettes.terminal = THEMES[themeName] as typeof ThemePalettes.terminal;
  const resolution = script.resolution ?? { width: 1280, height: 720 };
  const fps = script.fps ?? 30;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcast-ws-"));

  console.log(`[deepcast:workstation] Rendering with theme: ${themeName}`);
  console.log(`[deepcast:workstation] Resolution: ${resolution.width}x${resolution.height}`);
  console.log(`[deepcast:workstation] Steps: ${script.steps.length}`);

  const chromium = await getChromium();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: resolution,
    recordVideo: { dir: tempDir, size: resolution },
  });
  const page = await context.newPage();

  // Generate and load the workstation HTML
  const html = generateWorkstationHTML(script, theme, resolution, fps);
  const htmlPath = path.join(tempDir, "workstation.html");
  fs.writeFileSync(htmlPath, html);

  await page.goto(`file://${htmlPath}`);
  // Wait for fonts/canvas init
  await sleep(1500);

  // Wait for animation to complete (the HTML self-reports duration)
  const totalDuration = await page.evaluate(() => {
    return (window as any).__DEEPCAST_TOTAL_DURATION__ as number;
  }).catch(() => {
    // Fallback: sum up step durations manually
    return script.steps.reduce((acc, s) => acc + (s.duration ?? 4000), 0) + 5000;
  });

  console.log(`[deepcast:workstation] Animating ~${(totalDuration / 1000).toFixed(1)}s`);
  await sleep(totalDuration + 1000);

  await page.close();
  await context.close();
  await browser.close();

  // Find recorded video (Playwright saves .webm in the tempDir)
  const { execSync } = await import("child_process");
  const videoFiles = execSync(`dir "${tempDir}" /b 2>nul`, { encoding: "utf-8" })
    .split("\n")
    .filter((f: string) => f.trim().endsWith(".webm"));
  if (videoFiles.length === 0) throw new Error("No video recorded");
  const rawVideo = path.join(tempDir, videoFiles[0].trim());

  const hasFFmpeg = await validateFFmpeg();
  const duration = totalDuration / 1000;

  if (!hasFFmpeg) {
    console.warn("[deepcast:workstation] FFmpeg not found — copying raw webm");
    fs.copyFileSync(rawVideo, outputPath);
    return { duration, fileSize: fs.statSync(outputPath).size };
  }

  // FFmpeg re-encode with x264
  await new Promise<void>((resolve, reject) => {
    const fps = script.fps ?? 30;
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", rawVideo,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-movflags", "+faststart",
      outputPath,
    ]);
    let stderr = "";
    ffmpeg.stderr.on("data", (d) => { stderr += d.toString(); });
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else { console.warn(`[deepcast:workstation] FFmpeg exit ${code}`); resolve(); }
    });
    ffmpeg.on("error", reject);
  });

  const fileSize = fs.statSync(outputPath).size;
  return { duration, fileSize };
}

async function getChromium() {
  const pw = await import("playwright");
  return pw.chromium;
}

function generateWorkstationHTML(
  script: WorkstationScript,
  theme: typeof ThemePalettes.terminal,
  resolution: { width: number; height: number },
  fps: number
): string {
  const { width, height } = resolution;
  const stepsJson = JSON.stringify(script.steps);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: ${width}px;
  height: ${height}px;
  background: ${theme.bg};
  font-family: ${JSON.stringify(theme.font)};
  overflow: hidden;
  user-select: none;
}
#canvas { display: block; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<script>
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
canvas.width = ${width};
canvas.height = ${height};

// Theme
const t = ${JSON.stringify(theme)};
const steps = ${stepsJson};
const FPS = ${fps};

// Layout constants
const HEADER_H = 42;
const TERMINAL_X = 0;
const TERMINAL_Y = HEADER_H;
const TERMINAL_W = Math.floor(${width} * 0.62);
const TERMINAL_H = ${height} - TERMINAL_Y;
const SIDEBAR_X = TERMINAL_W;
const SIDEBAR_W = ${width} - TERMINAL_W;
const SIDEBAR_Y = HEADER_H;
const SIDEBAR_H = ${height} - SIDEBAR_Y;
const FOOTER_H = 36;
const FOOTER_Y = ${height} - FOOTER_H;
const FOOTER_W = TERMINAL_W;

// State
let currentStep = -1;
let stepProgress = 0; // 0-1 within current step
let globalTime = 0;
let lastTimestamp = null;
let commandEcho = ""; // command being typed out
let commandEchoDone = false;
let outputBuffer = ""; // output being typed
let outputDone = false;
let reasoningText = "";
let reasoningProgress = 0;
let filesChanged = [];
let fileAnimations = []; // { file, op, progress, x, y }
let terminalScroll = 0;
let cursorVisible = true;
let cursorBlink = 0;
let endCardShown = false;
let endCardProgress = 0;
let totalDuration = 0;

// Calculate step durations
const STEP_BASE = 3500;
steps.forEach((s, i) => {
  s._dur = s.duration ?? (STEP_BASE + (s.output?.length ?? 0) * 8 + (s.reasoning?.length ?? 0) * 12);
  totalDuration += s._dur + 300;
});
window.__DEEPCAST_TOTAL_DURATION__ = totalDuration + 3000;

// Easing
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOut(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Draw header
function drawHeader() {
  // Background
  ctx.fillStyle = t.windowBg;
  ctx.fillRect(0, 0, ${width}, HEADER_H);
  ctx.strokeStyle = t.windowBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(${width}, HEADER_H);
  ctx.stroke();

  // Title
  ctx.fillStyle = t.text;
  ctx.font = \`bold \${Math.floor(t.fontSize * 1.1)}px \${t.font}\`;
  ctx.fillText(${JSON.stringify(script.title)}, 16, 26);

  // Step indicator (right side of header)
  const stepText = \`\${currentStep < 0 ? 'ready' : 'step ' + (currentStep + 1) + '/' + steps.length}\`;
  ctx.fillStyle = t.dimText;
  ctx.font = \`\${t.fontSize}px \${t.font}\`;
  ctx.textAlign = 'right';
  ctx.fillText(stepText, TERMINAL_W - 16, 26);
  ctx.textAlign = 'left';

  // Progress bar
  const progress = (currentStep + 1) / steps.length;
  ctx.fillStyle = t.windowBorder;
  ctx.fillRect(TERMINAL_W + 1, HEADER_H - 3, SIDEBAR_W, 3);
  ctx.fillStyle = t.accent;
  ctx.fillRect(TERMINAL_W + 1, HEADER_H - 3, SIDEBAR_W * progress, 3);
}

// Draw sidebar header
function drawSidebarHeader() {
  ctx.fillStyle = t.windowBg;
  ctx.fillRect(SIDEBAR_X, SIDEBAR_Y, SIDEBAR_W, HEADER_H - SIDEBAR_Y);
  ctx.strokeStyle = t.windowBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(SIDEBAR_X, SIDEBAR_Y);
  ctx.lineTo(SIDEBAR_X, ${height});
  ctx.stroke();

  ctx.fillStyle = t.dimText;
  ctx.font = \`\${t.fontSize * 0.85}px \${t.font}\`;
  const label = currentStep < 0 ? 'reasoning' : (steps[currentStep].reasoning ? 'reasoning' : 'files');
  ctx.fillText(label.toUpperCase(), SIDEBAR_X + 14, 26);
}

// Draw terminal window
function drawTerminal() {
  // Window chrome
  ctx.fillStyle = t.windowBg;
  ctx.fillRect(TERMINAL_X, TERMINAL_Y, TERMINAL_W, TERMINAL_H);
  ctx.strokeStyle = t.windowBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(TERMINAL_X, TERMINAL_Y, TERMINAL_W, TERMINAL_H);

  // Traffic lights
  const r = 6, cy = TERMINAL_Y + 18;
  const colors = ['#ff5f57','#febc2e','#28c840'];
  colors.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(TERMINAL_X + 20 + i * 18, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });

  // Terminal title
  ctx.fillStyle = t.dimText;
  ctx.font = \`\${t.fontSize}px \${t.font}\`;
  ctx.textAlign = 'center';
  ctx.fillText('bash — 80x24', TERMINAL_X + TERMINAL_W / 2, cy + 4);
  ctx.textAlign = 'left';

  // Terminal content area
  const tx = TERMINAL_X + 16;
  const ty = TERMINAL_Y + HEADER_H + 12;
  const tw = TERMINAL_W - 32;
  const th = TERMINAL_H - HEADER_H - FOOTER_H - 20;

  ctx.font = \`\${t.fontSize}px \${t.font}\`;
  const lineH = t.fontSize * 1.6;

  // Scroll tracking
  let visibleLines = Math.floor(th / lineH);
  let scrollOffset = Math.max(0, terminalScroll);

  // Cursor blink
  cursorBlink += 0.1;
  cursorVisible = Math.sin(cursorBlink * 4) > 0;

  // Draw prompt lines from history
  let y = ty + (th - visibleLines * lineH);
  if (y < ty) y = ty;

  ctx.fillStyle = t.text;

  if (currentStep < 0) {
    // Idle state
    ctx.fillStyle = t.prompt;
    ctx.fillText('$ ', tx, ty + lineH);
    if (cursorVisible) {
      ctx.fillRect(tx + 14, ty + lineH - t.fontSize + 2, 8, t.fontSize);
    }
    return;
  }

  const step = steps[currentStep];
  const pp = easeInOut(clamp(stepProgress, 0, 1));

  // Draw completed steps faintly
  ctx.globalAlpha = 0.2;
  for (let i = 0; i < currentStep; i++) {
    const ps = steps[i];
    if (ps.command) {
      ctx.fillStyle = t.prompt;
      ctx.fillText('$ ', tx, y);
      ctx.fillStyle = t.text;
      ctx.fillText(ps.command, tx + 14, y);
      y += lineH;
    }
    if (ps.output) {
      ctx.fillStyle = t.dimText;
      const lines = wrapText(ps.output, tw - 14, t.fontSize);
      lines.forEach(l => { ctx.fillText(l, tx + 14, y); y += lineH; });
    }
    y += lineH * 0.5;
  }
  ctx.globalAlpha = 1;

  // Current command
  if (step.command !== undefined) {
    // Prompt
    ctx.fillStyle = t.prompt;
    ctx.fillText('$ ', tx, y);
    // Echo typing
    const echoLen = Math.floor(commandEcho.length * pp);
    ctx.fillStyle = t.text;
    ctx.fillText(commandEcho.substring(0, echoLen), tx + 14, y);

    if (pp >= 1 && !commandEchoDone) {
      commandEchoDone = true;
    }

    // Cursor on current line
    if (cursorVisible) {
      const cx = tx + 14 + ctx.measureText(commandEcho.substring(0, Math.floor(commandEcho.length * pp))).width + 2;
      ctx.fillRect(cx, y - t.fontSize + 2, 8, t.fontSize);
    }
    y += lineH;
  }

  // Output typing
  if (step.output && outputDone) {
    ctx.fillStyle = t.dimText;
    const lines = wrapText(step.output, tw - 14, t.fontSize);
    lines.forEach(l => { ctx.fillText(l, tx + 14, y); y += lineH; });
  } else if (step.output && commandEchoDone) {
    const outPp = clamp((pp - 0.5) * 2, 0, 1);
    if (outPp > 0) {
      const outChars = Math.floor(step.output.length * easeOut(outPp));
      const partial = step.output.substring(0, outChars);
      ctx.fillStyle = t.dimText;
      const lines = wrapText(partial, tw - 14, t.fontSize);
      lines.forEach(l => { ctx.fillText(l, tx + 14, y); y += lineH; });
    }
  }

  // File changes
  if (filesChanged.length > 0 && commandEchoDone) {
    y += lineH * 0.5;
    filesChanged.forEach(fc => {
      const op = fc.op === 'add' ? '+' : fc.op === 'del' ? '-' : '~';
      ctx.fillStyle = fc.op === 'add' ? t.fileAdd : fc.op === 'del' ? t.fileDel : t.fileEdit;
      ctx.fillText(op + ' ' + fc.file, tx, y);
      y += lineH;
    });
  }

  // Footer
  ctx.fillStyle = t.windowBg;
  ctx.fillRect(TERMINAL_X, FOOTER_Y, FOOTER_W, FOOTER_H);
  ctx.strokeStyle = t.windowBorder;
  ctx.beginPath();
  ctx.moveTo(TERMINAL_X, FOOTER_Y);
  ctx.lineTo(TERMINAL_X + FOOTER_W, FOOTER_Y);
  ctx.stroke();

  const stepLabel = step.label || \`step \${currentStep + 1}\`;
  ctx.fillStyle = t.dimText;
  ctx.font = \`\${t.fontSize}px \${t.font}\`;
  ctx.fillText(stepLabel, TERMINAL_X + 16, FOOTER_Y + 22);

  // Status right
  ctx.textAlign = 'right';
  ctx.fillText(currentStep < steps.length - 1 ? 'running...' : 'complete', TERMINAL_X + FOOTER_W - 16, FOOTER_Y + 22);
  ctx.textAlign = 'left';
}

function wrapText(text, maxWidth, fontSize) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  ctx.font = \`\${fontSize}px \${t.font}\`;
  for (const word of words) {
    const test = line + (line ? ' ' : '') + word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Draw sidebar
function drawSidebar() {
  ctx.fillStyle = t.windowBg;
  ctx.fillRect(SIDEBAR_X, SIDEBAR_Y, SIDEBAR_W, SIDEBAR_H);
  ctx.strokeStyle = t.windowBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(SIDEBAR_X, SIDEBAR_Y, SIDEBAR_W, SIDEBAR_H);

  const sx = SIDEBAR_X + 14;
  let sy = SIDEBAR_Y + HEADER_H + 16;
  const lineH = t.fontSize * 1.7;

  if (currentStep < 0) {
    ctx.fillStyle = t.dimText;
    ctx.font = \`italic \${t.fontSize}px \${t.font}\`;
    ctx.fillText('waiting for execution...', sx, sy);
    return;
  }

  const step = steps[currentStep];

  // Reasoning panel
  if (step.reasoning) {
    const rp = easeInOut(clamp(reasoningProgress, 0, 1));
    const visibleChars = Math.floor(step.reasoning.length * rp);
    const visible = step.reasoning.substring(0, visibleChars);

    ctx.fillStyle = t.accent;
    ctx.font = \`bold \${t.fontSize}px \${t.font}\`;
    ctx.fillText('> reasoning', sx, sy);
    sy += lineH * 0.8;

    ctx.fillStyle = t.text;
    const lines = wrapText(visible, SIDEBAR_W - 28, t.fontSize);
    lines.forEach(l => {
      if (sy > SIDEBAR_Y + SIDEBAR_H - 40) return;
      ctx.fillText(l, sx, sy);
      sy += lineH;
    });
    sy += lineH * 0.5;
  }

  // File changes panel
  const hasFiles = filesChanged.length > 0 || (step.files?.length > 0);
  if (hasFiles) {
    ctx.fillStyle = t.dimText;
    ctx.font = \`bold \${t.fontSize}px \${t.font}\`;
    ctx.fillText('> filesystem', sx, sy);
    sy += lineH * 0.8;

    ctx.font = \`\${t.fontSize}px \${t.font}\`;
    const allFiles = filesChanged.length > 0 ? filesChanged : (step.files || []).map(f => ({ file: f, op: 'add' }));
    allFiles.forEach(fc => {
      if (sy > SIDEBAR_Y + SIDEBAR_H - 40) return;
      const op = fc.op === 'add' ? '+' : fc.op === 'del' ? '-' : '~';
      const color = fc.op === 'add' ? t.fileAdd : fc.op === 'del' ? t.fileDel : t.fileEdit;
      ctx.fillStyle = color;
      ctx.fillText(op + ' ' + fc.file, sx, sy);
      sy += lineH;
    });
  }
}

// Draw end card
function drawEndCard() {
  const pp = easeInOut(clamp(endCardProgress, 0, 1));

  // Overlay
  ctx.globalAlpha = pp * 0.85;
  ctx.fillStyle = t.windowBg;
  ctx.fillRect(0, 0, ${width}, ${height});
  ctx.globalAlpha = 1;

  if (pp < 0.3) return;

  const tpp = easeInOut(clamp((pp - 0.3) / 0.7, 0, 1));
  const cx = ${width} / 2;
  const cy = ${height} / 2;

  ctx.textAlign = 'center';

  // Accent line
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  const lineW = 80 * tpp;
  ctx.beginPath();
  ctx.moveTo(cx - lineW / 2, cy - 60);
  ctx.lineTo(cx + lineW / 2, cy - 60);
  ctx.stroke();

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = tpp;
  ctx.font = \`bold 64px \${t.font}\`;
  ctx.fillText(${JSON.stringify(script.endTitle || 'complete')}, cx, cy);
  ctx.globalAlpha = 1;

  // Subtitle
  if (${JSON.stringify(script.endSubtitle)}) {
    ctx.fillStyle = t.accent;
    ctx.font = \`\${Math.floor(t.fontSize * 1.5)}px \${t.font}\`;
    ctx.fillText(${JSON.stringify(script.endSubtitle)}, cx, cy + 50);
  }

  // Brand
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = \`\${t.fontSize}px \${t.font}\`;
  ctx.fillText('deepcast workstation', cx, ${height} - 30);

  ctx.textAlign = 'left';
}

// Main loop
function frame(timestamp) {
  if (!lastTimestamp) lastTimestamp = timestamp;
  const dt = Math.min(timestamp - lastTimestamp, 50);
  lastTimestamp = timestamp;
  globalTime += dt;

  // Advance step machine
  if (currentStep < steps.length - 1) {
    const step = steps[currentStep];
    const elapsed = globalTime - (step._start ?? 0);
    stepProgress = clamp(elapsed / step._dur, 0, 1);

    if (elapsed >= step._dur) {
      // Next step
      currentStep++;
      stepProgress = 0;
      commandEchoDone = false;
      outputDone = false;
      filesChanged = [];
      reasoningProgress = 0;
      if (currentStep < steps.length) {
        steps[currentStep]._start = globalTime;
        commandEcho = steps[currentStep].command ?? '';
        if (steps[currentStep].output) {
          // Output shows after command is typed
        }
        if (steps[currentStep].files) {
          filesChanged = steps[currentStep].files.map(f => ({ file: f, op: 'add' }));
        }
        if (steps[currentStep].deletedFiles) {
          filesChanged.push(...steps[currentStep].deletedFiles.map(f => ({ file: f, op: 'del' })));
        }
        reasoningProgress = 0.01;
      }
    }

    // Advance typing
    if (!commandEchoDone && step.command) {
      const targetLen = Math.floor(step.command.length * easeInOut(stepProgress));
      commandEcho = step.command.substring(0, targetLen);
    }

    // Output typing (starts at 50% into step)
    if (step.output && stepProgress > 0.5 && commandEchoDone) {
      const outPp = clamp((stepProgress - 0.5) / 0.5, 0, 1);
      if (outPp >= 1) outputDone = true;
    }

    // Reasoning progress
    if (step.reasoning) {
      reasoningProgress = clamp(reasoningProgress + dt * 0.0015, 0, 1);
    }
  } else if (!endCardShown) {
    endCardShown = true;
    steps[steps.length - 1]._start = globalTime;
  }

  // End card animation
  if (endCardShown) {
    const elapsed = globalTime - steps[steps.length - 1]._start;
    endCardProgress = clamp(elapsed / 2500, 0, 1);
  }

  // Render
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, ${width}, ${height});

  // Subtle grid background
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx < ${width}; gx += 40) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ${height}); ctx.stroke();
  }
  for (let gy = 0; gy < ${height}; gy += 40) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(${width}, gy); ctx.stroke();
  }

  drawHeader();
  drawTerminal();
  drawSidebar();
  if (endCardShown) drawEndCard();

  requestAnimationFrame(frame);
}

// Expose theme as global for frame fn
const theme = t;

requestAnimationFrame(frame);
</script>
</body>
</html>`;
}

