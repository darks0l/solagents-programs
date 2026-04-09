#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { DemoScript } from "./types.js";
import { render, validateFFmpeg } from "./renderer.js";
import { postprocess } from "./postprocess.js";
import { WorkstationScript } from "./workstation-types.js";
import { renderWorkstation } from "./workstation-renderer.js";

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf-8"));

const program = new Command();

program
  .name("deepcast")
  .description("Automated product demo video generator")
  .version(pkg.version);

// deepcast init
program
  .command("init")
  .description("Generate a template demo script")
  .requiredOption("--url <url>", "Base URL of the product")
  .option("-o, --output <path>", "Output file path", "demo.json")
  .action(async (opts) => {
    const script: DemoScript = {
      title: "My Product Demo",
      tagline: "Built with purpose",
      url: opts.url,
      resolution: { width: 1280, height: 720 },
      fps: 30,
      sections: [
        {
          type: "title-card",
          duration: 3,
          title: "My Product Demo",
          subtitle: "by DARKSOL",
        },
        {
          type: "navigate",
          url: "/",
          wait: 2000,
        },
        {
          type: "screenshot",
          duration: 3,
          label: "Landing Page",
        },
        {
          type: "click",
          selector: "button, a",
          wait: 1500,
          label: "Primary Action",
        },
        {
          type: "wait",
          duration: 2,
        },
        {
          type: "end-card",
          duration: 3,
          title: "Thanks for watching.",
          subtitle: "darksol.net",
        },
      ],
    };

    fs.writeFileSync(opts.output, JSON.stringify(script, null, 2));
    console.log(`[deepcast] Template written to ${opts.output}`);
  });

// deepcast render
program
  .command("render")
  .description("Render a demo video from a script")
  .requiredOption("--url <url>", "Base URL (overrides script url)")
  .requiredOption("--script <path>", "Path to demo.json script")
  .requiredOption("--output <path>", "Output MP4 path")
  .option("--skip-postprocess", "Stop after raw recording (skip FFmpeg)", false)
  .action(async (opts) => {
    console.log(`[deepcast] v${pkg.version}`);

    // Validate FFmpeg
    const hasFFmpeg = await validateFFmpeg();
    if (!hasFFmpeg) {
      console.warn("[deepcast] Warning: FFmpeg not found. Install it to enable video encoding.");
      console.warn("[deepcast] On Windows: winget install ffmpeg  OR  choco install ffmpeg");
    }

    // Load script
    if (!fs.existsSync(opts.script)) {
      console.error(`[deepcast] Error: Script not found: ${opts.script}`);
      process.exit(1);
    }

    const script: DemoScript = JSON.parse(fs.readFileSync(opts.script, "utf-8"));

    // Override URL if provided
    if (opts.url) {
      script.url = opts.url;
    }

    console.log(`[deepcast] Script: ${opts.script}`);
    console.log(`[deepcast] URL: ${script.url}`);
    console.log(`[deepcast] Sections: ${script.sections.length}`);

    const startTime = Date.now();
    const rawVideo = await render(script, opts.output);
    const renderTime = Date.now() - startTime;

    if (opts.skipPostprocess) {
      console.log(`[deepcast] Raw recording saved: ${rawVideo}`);
      console.log(`[deepcast] Render time: ${(renderTime / 1000).toFixed(1)}s`);
      console.log(`[deepcast] Done (post-process skipped).`);
      return;
    }

    if (hasFFmpeg) {
      try {
        const result = await postprocess(rawVideo, opts.output, script);
        console.log(`[deepcast] ========================================`);
        console.log(`[deepcast] Output: ${opts.output}`);
        console.log(`[deepcast] Duration: ${result.duration.toFixed(1)}s`);
        console.log(`[deepcast] Size: ${(result.fileSize / 1024 / 1024).toFixed(2)} MB`);
        console.log(`[deepcast] Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        console.log(`[deepcast] Done!`);
      } catch (err) {
        console.error(`[deepcast] Post-process failed: ${err}`);
        console.log(`[deepcast] Raw recording available: ${rawVideo}`);
        process.exit(1);
      }
    } else {
      console.log(`[deepcast] FFmpeg not available. Raw recording: ${rawVideo}`);
    }
  });

// deepcast workstation
program
  .command("workstation")
  .description("Render a workstation execution visualization video")
  .requiredOption("--script <path>", "Path to workstation JSON script")
  .requiredOption("--output <path>", "Output MP4 path")
  .option("--theme <terminal|modern|cyberpunk>", "Visual theme", "terminal")
  .option("--skip-postprocess", "Stop after raw recording", false)
  .action(async (opts) => {
    console.log(`[deepcast:workstation] v${pkg.version}`);

    const hasFFmpeg = await validateFFmpeg();
    if (!hasFFmpeg) {
      console.warn("[deepcast] Warning: FFmpeg not found. Install it to enable video encoding.");
    }

    if (!fs.existsSync(opts.script)) {
      console.error(`[deepcast] Error: Script not found: ${opts.script}`);
      process.exit(1);
    }

    const script: WorkstationScript = JSON.parse(fs.readFileSync(opts.script, "utf-8"));
    if (opts.theme) script.theme = opts.theme as any;

    console.log(`[deepcast:workstation] Script: ${opts.script}`);
    console.log(`[deepcast:workstation] Theme: ${script.theme}`);
    console.log(`[deepcast:workstation] Steps: ${script.steps.length}`);

    const startTime = Date.now();

    try {
      const result = await renderWorkstation(script, opts.output);
      console.log(`[deepcast:workstation] ========================================`);
      console.log(`[deepcast:workstation] Output: ${opts.output}`);
      console.log(`[deepcast:workstation] Duration: ${result.duration.toFixed(1)}s`);
      console.log(`[deepcast:workstation] Size: ${(result.fileSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`[deepcast:workstation] Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      console.log(`[deepcast:workstation] Done!`);
    } catch (err) {
      console.error(`[deepcast:workstation] Render failed: ${err}`);
      process.exit(1);
    }
  });

// deepcast workstation:init
program
  .command("workstation:init")
  .description("Generate a template workstation script")
  .option("-o, --output <path>", "Output file path", "workstation-demo.json")
  .option("--theme <terminal|modern|cyberpunk>", "Theme", "terminal")
  .action(async (opts) => {
    const script: WorkstationScript = {
      title: "My Agent Demo",
      subtitle: "Built with teeth.",
      theme: opts.theme as any,
      steps: [
        {
          label: "Initializing agent",
          command: "claude --print 'Analyze this codebase'",
          output: "Loading 47 files... done.\nToken context: 32k / 200k",
          reasoning: "This codebase has 47 files across 6 modules. The main entry point is index.ts which orchestrates the agent loop.",
          duration: 4000,
        },
        {
          label: "Reading source files",
          command: "find src -name '*.ts' | head -20",
          output: "src/agent.ts\nsrc/router.ts\nsrc/plugins/*.ts (14 files)\nsrc/utils/*.ts (12 files)",
          files: ["src/agent.ts", "src/router.ts", "src/plugins/"],
          duration: 3000,
        },
        {
          label: "Running tests",
          command: "pnpm test",
          output: "✓ 127 tests passed (4.2s)\n  coverage: 84%",
          reasoning: "All 127 tests pass. Coverage is good. One minor issue in the router module — edge case with empty string matching.",
          files: ["src/router.ts"],
          duration: 5000,
        },
        {
          label: "Building production bundle",
          command: "pnpm build",
          output: "dist/main.js  142kb\ndist/worker.js  89kb",
          files: ["dist/main.js", "dist/worker.js"],
          duration: 4000,
        },
      ],
      endTitle: "complete",
      endSubtitle: "deepcast workstation",
    };

    fs.writeFileSync(opts.output, JSON.stringify(script, null, 2));
    console.log(`[deepcast] Workstation template written to ${opts.output}`);
    console.log(`[deepcast] Run: deepcast workstation --script ${opts.output} --output demo.mp4`);
  });

program.parse();
