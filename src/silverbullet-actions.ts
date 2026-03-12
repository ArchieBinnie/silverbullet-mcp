import { Page } from "playwright";
import {
  getSharedContext,
  invalidateSharedContext,
  pagePathToUrl,
  filenameToPagePath,
  SB_BROWSER_URL,
} from "./silverbullet-browser.js";

/**
 * Ensures the SilverBullet client is fully initialized and syscalls are ready.
 */
async function ensureClientReady(page: Page, label: string): Promise<void> {
  const t0 = Date.now();
  console.log(`[${label}] Ensuring client is ready...`);

  const currentUrl = page.url();
  console.log(`[${label}] Current URL: "${currentUrl}"`);

  // Initial navigation if needed
  if (currentUrl === "about:blank") {
    console.log(`[${label}] Initial navigation to index`);
    await page.goto(pagePathToUrl("index"), { waitUntil: "domcontentloaded" });
  }

  // Diagnostic polling loop
  const timeout = 30000;
  const pollInterval = 1000;
  const logInterval = 5000;
  let lastLogged = 0;

  while (Date.now() - t0 < timeout) {
    const state = await page.evaluate(() => {
      const c = (window as any).client;
      return {
        hasClient: !!c,
        systemReady: c?.systemReady,
        hasClientSystem: !!c?.clientSystem,
        hasSystem: !!c?.clientSystem?.system,
        hasLocalSyscall: typeof c?.clientSystem?.system?.localSyscall === 'function',
        registeredSyscalls: c?.clientSystem?.system?.registeredSyscalls ? Array.from(c.clientSystem.system.registeredSyscalls.keys()) : [],
        url: window.location.href,
      };
    });

    if (state.url?.includes("/.auth")) {
      console.log(`[${label}] Auth redirect detected at ${state.url}`);
      throw new Error("AUTH_EXPIRED");
    }

    // We consider it ready if client exists AND either systemReady is true 
    // OR we have at least the core syscalls registered.
    const coreSyscallsReady = state.hasLocalSyscall && state.registeredSyscalls.includes("index.getObjectByRef");

    if (state.hasClient && (state.systemReady || coreSyscallsReady)) {
      console.log(`[${label}] Client ready in ${Date.now() - t0}ms (systemReady=${state.systemReady}, hasLocalSyscall=${state.hasLocalSyscall}, coreSyscallsReady=${coreSyscallsReady})`);
      return;
    }

    if (Date.now() - lastLogged > logInterval) {
      console.log(`[${label}] Waiting for client... State: ${JSON.stringify({
        hasClient: state.hasClient,
        systemReady: state.systemReady,
        hasLocalSyscall: state.hasLocalSyscall,
        coreSyscallsReady,
        syscallCount: state.registeredSyscalls.length
      })}`);
      lastLogged = Date.now();
    }

    // If we have client but it's taking too long and syscalls are missing, 
    // maybe it's stuck. We can't easily trigger commands if syscalls are missing,
    // but we can try to wait.
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // Final diagnostic on timeout
  const finalState = await page.evaluate(() => {
    const c = (window as any).client;
    return {
      hasClient: !!c,
      systemReady: c?.systemReady,
      hasClientSystem: !!c?.clientSystem,
      hasSystem: !!c?.clientSystem?.system,
      hasLocalSyscall: typeof c?.clientSystem?.system?.localSyscall === 'function',
      keys: c ? Object.keys(c) : [],
      url: window.location.href,
    };
  });

  console.error(`[${label}] Client ready timeout. Final State: ${JSON.stringify(finalState)}`);
  throw new Error(`Timed out waiting for SilverBullet client to be ready at ${finalState.url}. State: ${JSON.stringify(finalState)}`);
}

/**
 * Renames a SilverBullet page via the headless browser.
 */
export async function renamePage(
  oldFilename: string,
  newFilename: string
): Promise<{ message: string }> {
  const t0 = Date.now();
  const oldPath = filenameToPagePath(oldFilename);
  const newPath = filenameToPagePath(newFilename);
  const label = `renamePage`;
  console.log(`[${label}] START "${oldPath}" → "${newPath}"`);

  const context = await getSharedContext();
  const page = await context.newPage();

  try {
    const oldUrl = pagePathToUrl(oldPath);
    await page.goto(oldUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });

    if (page.url().includes("/.auth")) {
      invalidateSharedContext();
      throw new Error("Session expired. Please retry.");
    }

    const pageNamer = page.locator("#sb-current-page");
    await pageNamer.waitFor({ timeout: 10_000 });

    // Wait for initial index to complete (diagnostic loop)
    const tIndex = Date.now();
    while (Date.now() - tIndex < 60000) {
      const isIndexReady = await page.evaluate(() => {
        const cs = (window as any).client?.clientSystem;
        return typeof cs?.hasInitialIndexCompleted === "function" && cs.hasInitialIndexCompleted();
      });
      if (isIndexReady) {
        console.log(`[${label}] Index ready in ${Date.now() - tIndex}ms`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    await pageNamer.click();
    const miniEditorContent = pageNamer.locator(".cm-content");
    await miniEditorContent.waitFor({ timeout: 5_000 });
    await miniEditorContent.click({ clickCount: 3 });
    await page.keyboard.type(newPath);
    await page.keyboard.press("Enter");

    await page.waitForURL((url) => decodeURIComponent(url.pathname) === `/${newPath}`, { timeout: 15_000 });
    await page.locator("#sb-current-page.sb-saved").waitFor({ timeout: 10_000 });

    return { message: `Successfully renamed "${oldPath}" to "${newPath}"` };
  } finally {
    await page.close();
  }
}

/**
 * Synchronizes the SilverBullet client with disk changes.
 */
export async function syncSystem(
  applyToSpace: boolean = false
): Promise<{ message: string }> {
  const label = `syncSystem`;
  const t0 = Date.now();
  console.log(`[${label}] START (applyToSpace=${applyToSpace})`);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const context = await getSharedContext();
    const page = await context.newPage();

    try {
      await ensureClientReady(page, label);

      await page.evaluate(async (applyToSpace) => {
        const client = (window as any).client;
        const waitQueue = () =>
          client.clientSystem.system.localSyscall("mq.awaitEmptyQueue", [
            "indexQueue",
          ]);

        console.log("[Browser] (syncSystem) Triggering Space: Reindex...");
        await client.runCommandByName("Space: Reindex");
        await waitQueue();

        console.log("[Browser] (syncSystem) Triggering System: Reload...");
        await client.runCommandByName("System: Reload");
        await new Promise((r) => setTimeout(r, 1000));

        if (applyToSpace) {
          console.log("[Browser] (syncSystem) Triggering Space: Reindex All...");
          try {
            await client.runCommandByName("Space: Reindex All");
            await waitQueue();
          } catch (e: any) {
            console.warn(
              "Reindex All failed (might not be available):",
              e.message,
            );
          }
        }
      }, applyToSpace);

      console.log(`[${label}] DONE in ${Date.now() - t0}ms`);
      return { message: "System synchronized successfully." };
    } catch (err: any) {
      console.error(`[${label}] (attempt ${attempt}) ERROR: ${err.message}`);
      await page.close();
      if (attempt === 1 || err.message === "AUTH_EXPIRED") {
        invalidateSharedContext();
        if (attempt === 2) throw new Error(`Sync failed after retry: ${err.message}`);
        continue;
      }
      throw new Error(`Sync failed: ${err.message}`);
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }
  throw new Error("Unreachable exit from syncSystem loop");
}

/**
 * Validates a string of Space Lua code.
 */
export async function validateLua(code: string): Promise<{
  valid: boolean;
  error?: string;
  line?: number;
  column?: number;
}> {
  const label = `validateLua`;
  const t0 = Date.now();
  console.log(`[${label}] Validating ${code.length} chars of Lua`);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const context = await getSharedContext();
    const page = await context.newPage();

    try {
      await ensureClientReady(page, label);

      const result = await page.evaluate(async (code) => {
        const client = (window as any).client;
        try {
          await client.clientSystem.system.localSyscall("lua.parse", [code]);
          return { valid: true };
        } catch (err: any) {
          const match = err.message.match(/line (\d+), column (\d+)/);
          return {
            valid: false,
            error: err.message,
            line: match ? parseInt(match[1]) : undefined,
            column: match ? parseInt(match[2]) : undefined,
          };
        }
      }, code);

      console.log(`[${label}] DONE in ${Date.now() - t0}ms`);
      return result;
    } catch (err: any) {
      console.error(`[${label}] (attempt ${attempt}) ERROR: ${err.message}`);
      await page.close();
      if (attempt === 1 || err.message === "AUTH_EXPIRED") {
        invalidateSharedContext();
        continue;
      }
      throw new Error(`Validation failed: ${err.message}`);
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }
  throw new Error("Unreachable exit from validateLua loop");
}

/**
 * Executes a Lua Integrated Query (LIQ) or raw Lua expression.
 */
export async function runQuery(queryText: string): Promise<{ results: any[] }> {
  const label = `runQuery`;
  const t0 = Date.now();
  console.log(`[${label}] Executing query: ${queryText.substring(0, 50)}...`);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const context = await getSharedContext();
    const page = await context.newPage();

    try {
      await ensureClientReady(page, label);

      const results = await page.evaluate(async (queryText) => {
        const client = (window as any).client;
        
        // If it starts with "from", "select", etc (common LIQ keywords), 
        // or specifically "query[[", treat as LIQ.
        // Otherwise, it might be a raw Lua expression.
        let finalExpression = queryText.trim();
        const isLIQ = finalExpression.startsWith("query[[") || 
                      !!finalExpression.match(/^(from|select|where|order by|group by|limit)\b/i);
        
        if (!isLIQ && !finalExpression.startsWith("return ")) {
          finalExpression = `return (${finalExpression})`;
        } else if (isLIQ && !finalExpression.startsWith("query[[")) {
          finalExpression = `query[[${finalExpression}]]`;
        }

        const rawResults = await client.clientSystem.system.localSyscall(
          "lua.evalExpression",
          [finalExpression],
        );

        // Convert Lua values to JS
        if (client.spaceLua?.luaValueToJS) {
          if (Array.isArray(rawResults)) {
            return rawResults.map((r: any) => client.spaceLua.luaValueToJS(r));
          }
          return client.spaceLua.luaValueToJS(rawResults);
        }
        
        // Fallback: try to serialize via toJSON if available in Lua
        try {
           const json = await client.clientSystem.system.localSyscall("lua.evalExpression", [`toJSON(${finalExpression})`]);
           return JSON.parse(json);
        } catch (e) {
           return rawResults;
        }
      }, queryText);

      console.log(`[${label}] DONE in ${Date.now() - t0}ms`);
      return { results: Array.isArray(results) ? results : [results] };
    } catch (err: any) {
      console.error(`[${label}] (attempt ${attempt}) ERROR: ${err.message}`);
      await page.close();
      if (attempt === 1 || err.message === "AUTH_EXPIRED") {
        invalidateSharedContext();
        continue;
      }
      throw new Error(`Query failed: ${err.message}`);
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }
  throw new Error("Unreachable exit from runQuery loop");
}
