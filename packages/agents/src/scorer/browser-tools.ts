/**
 * The two browser tools for `type: browser-agent`.
 *
 * `screenshot` covers the common case (look at a page) with no code;
 * `run_playwright_script` covers everything else (click, type, hover, capture a
 * sequence). Both return their images as image content parts via
 * `toModelOutput`, so the model sees the page without a hand-rolled vision loop.
 *
 * Playwright is `--external` in the bundle: it is installed in the container
 * image (`bunsen/visual`), not inlined. The loader therefore runs lazily inside
 * `execute` — importing it at module load would break every non-visual scorer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { tool } from 'ai';
import { z } from 'zod';
import {
  DEFAULT_PLAYWRIGHT_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_DELAY_MS,
  DEFAULT_VIEWPORT,
  MAX_INLINE_IMAGES,
  MAX_TOOL_RESULT_CHARS,
  NAVIGATION_TIMEOUT_MS,
  SCORER_OUTPUT_DIR,
  SELECTOR_TIMEOUT_MS,
} from './config.js';
import { truncateHeadTail } from './evidence.js';
import type { ScorerContext, ScorerState, ScorerTool } from './tools.js';

type Chromium = typeof import('playwright').chromium;
type Browser = import('playwright').Browser;
type Page = import('playwright').Page;

interface CapturedImage {
  filename: string;
  base64: string;
}

/** What a browser tool returns: prose for the model plus the images it captured. */
export interface BrowserToolOutput {
  text: string;
  images: CapturedImage[];
}

// ============================================================================
// Playwright loader — resolved once, memoized
// ============================================================================

/** Where a container image installs Playwright globally, before normal resolution. */
const PLAYWRIGHT_PATHS = [
  '/usr/lib/node_modules/playwright',
  '/usr/local/lib/node_modules/playwright',
  'playwright',
];

let chromiumPromise: Promise<Chromium> | null = null;

/**
 * Resolve Playwright's `chromium` once per process. The bundle is CJS with an
 * `import.meta.url` shim, so `createRequire` works for the global install
 * paths; `import()` is the fallback for a normal `node_modules` layout.
 */
export function loadChromium(): Promise<Chromium> {
  if (chromiumPromise) return chromiumPromise;
  chromiumPromise = (async () => {
    const require = createRequire(import.meta.url);
    for (const candidate of PLAYWRIGHT_PATHS) {
      try {
        const loaded = require(candidate) as { chromium?: Chromium };
        if (loaded.chromium) return loaded.chromium;
      } catch {
        // try the next candidate
      }
    }
    const imported = await import('playwright');
    return imported.chromium;
  })();
  return chromiumPromise;
}

/** Reset the memoized loader. Test seam only. */
export function resetChromiumLoader(): void {
  chromiumPromise = null;
}

async function browserFor(state: ScorerState): Promise<Browser> {
  if (!state.browser) {
    const chromium = await loadChromium();
    state.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return state.browser;
}

/** Close the shared browser, if one was launched. Safe to call twice. */
export async function closeBrowser(state: ScorerState): Promise<void> {
  if (!state.browser) return;
  try {
    await state.browser.close();
  } catch {
    // a browser that already died needs no closing
  }
  state.browser = null;
}

function browserFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find module|MODULE_NOT_FOUND|Failed to resolve/i.test(message)) {
    return (
      'Playwright is not installed in this container, so pages cannot be rendered. ' +
      'A browser-agent criterion needs an image with a browser, such as bunsen/visual. ' +
      `(${message})`
    );
  }
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      'Playwright is installed but its browser binary is missing, so pages cannot be rendered. ' +
      `The image needs a browser install (bunsen/visual ships one). (${message})`
    );
  }
  return `The browser failed: ${message}`;
}

// ============================================================================
// Screenshot saving
// ============================================================================

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'criterion';
}

/**
 * Save one screenshot to the scorer's writable output dir as
 * `<criterion>-<n>.png` and remember the filename for the run's artifacts.
 */
export function saveScreenshot(
  buffer: Buffer,
  ctx: ScorerContext,
  state: ScorerState,
): CapturedImage {
  const dir = path.join(SCORER_OUTPUT_DIR, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${slugify(ctx.config.id)}-${state.screenshots.length + 1}.png`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  state.screenshots.push(filename);
  ctx.log(`[screenshot] saved ${filename}`);
  return { filename, base64: buffer.toString('base64') };
}

/**
 * Text plus up to {@link MAX_INLINE_IMAGES} images, in the v7 tagged-union
 * shape. Further screenshots are named rather than attached — they are on disk
 * and in the run's artifacts either way.
 */
export function browserModelOutput(output: BrowserToolOutput) {
  const attached = output.images.slice(0, MAX_INLINE_IMAGES);
  const listed = output.images.slice(MAX_INLINE_IMAGES);
  const value: Array<
    | { type: 'text'; text: string }
    | {
        type: 'file';
        mediaType: string;
        filename?: string;
        data: { type: 'data'; data: string };
      }
  > = [{ type: 'text', text: output.text }];
  for (const image of attached) {
    value.push({
      type: 'file',
      mediaType: 'image/png',
      filename: image.filename,
      data: { type: 'data', data: image.base64 },
    });
  }
  if (listed.length > 0) {
    value.push({
      type: 'text',
      text:
        `${listed.length} further screenshot(s) were saved but not attached here: ` +
        `${listed.map((image) => image.filename).join(', ')}.`,
    });
  }
  return { type: 'content' as const, value };
}

async function newPage(
  state: ScorerState,
  viewport: { width?: number; height?: number } | undefined,
): Promise<Page> {
  const browser = await browserFor(state);
  return browser.newPage({
    viewport: {
      width: viewport?.width ?? DEFAULT_VIEWPORT.width,
      height: viewport?.height ?? DEFAULT_VIEWPORT.height,
    },
  });
}

const viewportSchema = z
  .object({
    width: z.number().describe(`Viewport width in CSS pixels. Defaults to ${DEFAULT_VIEWPORT.width}.`),
    height: z
      .number()
      .describe(`Viewport height in CSS pixels. Defaults to ${DEFAULT_VIEWPORT.height}.`),
  })
  .partial()
  .optional();

// ============================================================================
// screenshot
// ============================================================================

export function createScreenshotTool(ctx: ScorerContext, state: ScorerState): ScorerTool {
  return tool({
    description:
      'Open a URL in a headless browser and capture it; the image comes back with the result. ' +
      'Start the server first if the page is served by one.',
    inputSchema: z.object({
      url: z.string().describe('URL to open, e.g. http://localhost:3000.'),
      full_page: z
        .boolean()
        .optional()
        .describe('Capture the whole scrollable page instead of the viewport. Defaults to false.'),
      viewport: viewportSchema,
      wait_for_selector: z
        .string()
        .optional()
        .describe('CSS selector to wait for before capturing.'),
      delay_ms: z
        .number()
        .optional()
        .describe(`How long to settle after load before capturing. Defaults to ${DEFAULT_SCREENSHOT_DELAY_MS}.`),
    }),
    execute: async (input): Promise<BrowserToolOutput> => {
      let page: Page | undefined;
      try {
        page = await newPage(state, input.viewport);
        await page.goto(input.url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'networkidle' });
        if (input.wait_for_selector) {
          await page.waitForSelector(input.wait_for_selector, { timeout: SELECTOR_TIMEOUT_MS });
        }
        const delayMs = input.delay_ms ?? DEFAULT_SCREENSHOT_DELAY_MS;
        if (delayMs > 0) await page.waitForTimeout(delayMs);
        const buffer = await page.screenshot({ fullPage: input.full_page ?? false, type: 'png' });
        const image = saveScreenshot(Buffer.from(buffer), ctx, state);
        return { text: `Captured ${input.url} as ${image.filename}.`, images: [image] };
      } catch (error) {
        return { text: browserFailure(error), images: [] };
      } finally {
        await page?.close().catch(() => undefined);
      }
    },
    toModelOutput: ({ output }) => browserModelOutput(output),
  });
}

// ============================================================================
// run_playwright_script
// ============================================================================

export function createRunPlaywrightScriptTool(ctx: ScorerContext, state: ScorerState): ScorerTool {
  return tool({
    description:
      'Run Playwright code against a page to interact with it — click, type, hover, wait — and ' +
      'capture screenshots along the way. The code is the body of an async function with page, ' +
      'browser, screenshot(options?) and console in scope.',
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          'Async function body. Available: page, browser, screenshot({ full_page?, delay_ms? }) which captures and returns a filename, and console.',
        ),
      url: z.string().optional().describe('URL to open before running the code.'),
      timeout_ms: z
        .number()
        .optional()
        .describe(`How long the code may run before it is abandoned. Defaults to ${DEFAULT_PLAYWRIGHT_TIMEOUT_MS}.`),
      viewport: viewportSchema,
    }),
    execute: async (input): Promise<BrowserToolOutput> => {
      const timeoutMs = input.timeout_ms ?? DEFAULT_PLAYWRIGHT_TIMEOUT_MS;
      const images: CapturedImage[] = [];
      const consoleOutput: string[] = [];
      let page: Page | undefined;
      try {
        page = await newPage(state, input.viewport);
        if (input.url) {
          await page.goto(input.url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'networkidle' });
        }

        const activePage = page;
        const screenshot = async (options?: { full_page?: boolean; delay_ms?: number }) => {
          if (options?.delay_ms && options.delay_ms > 0) await activePage.waitForTimeout(options.delay_ms);
          const buffer = await activePage.screenshot({
            fullPage: options?.full_page ?? false,
            type: 'png',
          });
          const image = saveScreenshot(Buffer.from(buffer), ctx, state);
          images.push(image);
          return image.filename;
        };

        const record = (level: string) => (...args: unknown[]) => {
          const line = args
            .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
            .join(' ');
          consoleOutput.push(level === 'log' ? line : `[${level}] ${line}`);
        };
        const scriptConsole = { log: record('log'), error: record('error'), warn: record('warn') };

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const body = new AsyncFunction('page', 'browser', 'screenshot', 'console', input.code);

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the script was still running after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });
        let returned: unknown;
        try {
          returned = await Promise.race([
            body(activePage, state.browser, screenshot, scriptConsole),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        const parts = [`The script ran. ${images.length} screenshot(s) captured.`];
        if (consoleOutput.length > 0) parts.push(`console:\n${consoleOutput.join('\n')}`);
        if (returned !== undefined) parts.push(`returned: ${JSON.stringify(returned)}`);
        return {
          text: truncateHeadTail(parts.join('\n\n'), MAX_TOOL_RESULT_CHARS, 'script output'),
          images,
        };
      } catch (error) {
        const parts = [browserFailure(error)];
        if (consoleOutput.length > 0) parts.push(`console:\n${consoleOutput.join('\n')}`);
        if (images.length > 0) parts.push(`${images.length} screenshot(s) were captured before the failure.`);
        return {
          text: truncateHeadTail(parts.join('\n\n'), MAX_TOOL_RESULT_CHARS, 'script output'),
          images,
        };
      } finally {
        await page?.close().catch(() => undefined);
      }
    },
    toModelOutput: ({ output }) => browserModelOutput(output),
  });
}
