import { chromium, Browser, BrowserContext, Page } from "playwright";
import { SB_API_BASE_URL } from "./config.js";
import * as fs from "fs";

export const SB_BROWSER_URL = process.env.SB_BROWSER_URL ?? SB_API_BASE_URL;
const PERSISTENT_DATA_DIR = "/tmp/sb-rename-browser-data";

let browser: Browser | null = null;
let sharedContext: BrowserContext | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ 
      headless: true, 
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] 
    });
  }
  return browser;
}

export function parseCredentials() {
  const sbUser = process.env.SB_USER ?? "admin:admin";
  const [username, password] = sbUser.split(":");
  return { username, password };
}

export function filenameToPagePath(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

export function pagePathToUrl(pagePath: string): string {
  return `${SB_BROWSER_URL}/${pagePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function performLogin(page: Page): Promise<void> {
  const { username, password } = parseCredentials();
  console.log(`[Browser] (Login) Attempting UI login for user: ${username}`);
  
  try {
    await page.goto(`${SB_BROWSER_URL}/.auth`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.click('button:has-text("Login")')
    ]);
    console.log("[Browser] (Login) UI login successful.");
  } catch (err: any) {
    console.error(`[Browser] (Login) FATAL ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * Creates a new authenticated BrowserContext.
 */
export async function getAuthenticatedContext(
  opts: { viewportHeight?: number } = {}
): Promise<BrowserContext> {
  const b = await getBrowser();
  const context = await b.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: opts.viewportHeight ?? 720 },
  });

  const page = await context.newPage();
  try {
    await page.goto(`${SB_BROWSER_URL}/index`, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (page.url().includes("/.auth")) {
      await performLogin(page);
    }
  } finally {
    await page.close();
  }

  return context;
}

export async function getSharedContext(): Promise<BrowserContext> {
  if (sharedContext) {
    // Check if the browser backing this context is still alive
    const b = sharedContext.browser();
    if (!b || !b.isConnected()) {
      sharedContext = null;
    }
  }

  if (!sharedContext) {
    if (fs.existsSync(PERSISTENT_DATA_DIR)) {
      console.log(`[Browser] Clearing persistent data dir: ${PERSISTENT_DATA_DIR}`);
      fs.rmSync(PERSISTENT_DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(PERSISTENT_DATA_DIR, { recursive: true });
    console.log(`[Browser] Launching persistent context...`);

    sharedContext = await chromium.launchPersistentContext(PERSISTENT_DATA_DIR, {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    sharedContext.on("close", () => {
      sharedContext = null;
    });

    const page = await sharedContext.newPage();
    try {
      console.log(`[Browser] (init) Navigating to index...`);
      await page.goto(`${SB_BROWSER_URL}/index`, {
        waitUntil: "domcontentloaded",
      });
      if (page.url().includes("/.auth")) {
        await performLogin(page);
      }
      
      // Diagnostic polling loop for initial boot
      const tStart = Date.now();
      while (Date.now() - tStart < 30000) {
        const isReady = await page.evaluate(() => (window as any).client?.systemReady);
        if (isReady) {
          console.log(`[Browser] (init) Client ready in ${Date.now() - tStart}ms`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err: any) {
      console.error(`[Browser] (init) Failed to initialize client: ${err.message}`);
      // Don't fail the context creation, but log it.
      // ensureClientReady will handle it on actual use.
    } finally {
      await page.close();
    }
  }

  return sharedContext;
}

export function invalidateSharedContext(): void {
  sharedContext = null;
}
