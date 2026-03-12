import { BrowserContext } from "playwright";
import {
  getAuthenticatedContext,
  pagePathToUrl,
  filenameToPagePath,
  SB_BROWSER_URL,
} from "./silverbullet-browser.js";

/**
 * Reads a SilverBullet note via a headless browser, returning the fully
 * rendered content with all Space Lua template expressions evaluated.
 *
 * Wait strategy:
 *   Phase A — waitForSelector('.sb-lua-wrapper', 10s): waits for CodeMirror
 *     to create LuaWidget decorations. A one-shot evaluate() immediately after
 *     goto() races against this and frequently returns 0.
 *   Phase B — waitForFunction polling for .sb-lua-directive-block/-inline (15s):
 *     these classes are only added when LuaWidget.renderContent() completes.
 *     This is the only reliable DOM signal that Space Lua evaluation is done.
 */
export async function readNoteRendered(filename: string): Promise<string> {
  const t0 = Date.now();
  console.log(`[readNoteRendered] START "${filename}"`);

  // Use a very tall viewport so CodeMirror renders all decorations into the DOM.
  // LuaWidget.toDOM() is only called for decorations within the visible viewport;
  // if ${...} expressions are below the fold they never get a .sb-lua-wrapper span
  // and Space Lua evaluation never starts.
  const context: BrowserContext = await getAuthenticatedContext({
    viewportHeight: 10_000,
  });

  try {
    const page = await context.newPage();
    console.log(`[readNoteRendered] Auth OK (${Date.now() - t0}ms)`);

    // Log browser console errors and failed responses to aid debugging
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.warn(`[readNoteRendered] browser console error: ${msg.text()}`);
      }
    });
    page.on("response", (res) => {
      if (!res.ok()) {
        console.warn(`[readNoteRendered] HTTP ${res.status()} ${res.url()}`);
      }
    });

    // Step 1: Navigate to the note page and wait for full network idle.
    // "networkidle" waits until there are no more than 0 in-flight network
    // requests for at least 500ms after the load event. Space Lua template
    // expressions (${template.each(...)}) fire async index queries AFTER the
    // page content loads into CodeMirror, and "load" alone would return before
    // those queries complete — leaving the rendered output empty.
    const pagePath = filenameToPagePath(filename);
    const targetUrl = pagePathToUrl(pagePath);
    console.log(`[readNoteRendered] Navigating to ${targetUrl}`);

    const response = await page.goto(targetUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Detect auth redirect: if we ended up on /.auth the cookie wasn't accepted
    const finalUrl = page.url();
    if (finalUrl.includes("/.auth")) {
      throw new Error(
        `Auth redirect detected — session cookie not accepted. Final URL: ${finalUrl}`
      );
    }
    console.log(
      `[readNoteRendered] Navigated+idle: ${finalUrl} status=${response?.status()} (${Date.now() - t0}ms)`
    );

    // Step 2: Sanity check that CodeMirror rendered real content.
    await page
      .waitForFunction(() => document.querySelectorAll(".cm-line").length > 2, {
        timeout: 5_000,
      })
      .catch(() => {
        throw new Error(
          `CodeMirror has ≤2 lines for "${filename}" after networkidle — ` +
            `page may not exist or the editor failed to initialize`
        );
      });
    const lineCount: number = await page.evaluate(
      () => document.querySelectorAll(".cm-line").length
    );
    console.log(
      `[readNoteRendered] CodeMirror rendered ${lineCount} lines (${Date.now() - t0}ms)`
    );

    // Step 3: Wait for Space Lua expressions to evaluate.
    //
    // Phase A: wait for at least one wrapper to appear
    const firstWrapper = await page
      .waitForSelector(".sb-lua-wrapper", { timeout: 10_000 })
      .catch(() => null);
    const wrapperCount: number = await page.evaluate(
      () => document.querySelectorAll(".sb-lua-wrapper").length
    );
    if (firstWrapper) {
      console.log(
        `[readNoteRendered] Found ${wrapperCount} .sb-lua-wrapper elements (${Date.now() - t0}ms)`
      );
    } else {
      console.log(
        `[readNoteRendered] No .sb-lua-wrapper elements after 10s — ` +
          `page has no \${...} expressions or LuaWidget init failed`
      );
    }

    // Phase B: wait for all wrappers to receive the directive class.
    if (firstWrapper) {
      await page
        .waitForFunction(
          () => {
            const wrappers = document.querySelectorAll(".sb-lua-wrapper");
            return Array.from(wrappers).every(
              (w) =>
                w.querySelector(
                  ".sb-lua-directive-block, .sb-lua-directive-inline"
                ) !== null
            );
          },
          { timeout: 15_000 }
        )
        .catch(() => {
          console.warn(
            `[readNoteRendered] Timed out waiting for Space Lua evaluation on "${filename}" — returning partial render`
          );
        });
      console.log(
        `[readNoteRendered] Space Lua evaluated (${Date.now() - t0}ms)`
      );
    }

    // Step 4: Extract filtered HTML to preserve links and structure.
    // We return a sanitized HTML fragment that keeps meaningful content
    // (headers, links, list structures from Lua widgets) while stripping
    // internal editor noise.
    const content = await page.evaluate(() => {
      const editor = document.querySelector("#sb-editor .cm-content");
      if (!editor) return null;

      const output: string[] = [];
      const children = Array.from(editor.children);

      for (const child of children) {
        // 1. Handle Space Lua widgets (which contain rendered HTML like <ul>/<li>)
        const luaWidget = child.querySelector(
          ".sb-lua-directive-block, .sb-lua-directive-inline"
        );
        if (luaWidget) {
          const widgetContent = luaWidget.querySelector(".content");
          if (widgetContent) {
            const clone = widgetContent.cloneNode(true) as HTMLElement;
            // Remove UI elements like reload/copy/edit buttons
            clone.querySelectorAll(".button-bar").forEach((n) => n.remove());
            output.push(clone.innerHTML);
            continue;
          }
        }

        // 2. Handle regular editor lines
        if (child.classList.contains("cm-line")) {
          const clone = child.cloneNode(true) as HTMLElement;
          // Strip CodeMirror internal decorations but keep wiki links
          clone
            .querySelectorAll(
              '.cm-widgetBuffer, span[contenteditable="false"]:not(.sb-lua-wrapper):not(.sb-wiki-link)'
            )
            .forEach((n) => n.remove());

          // Preserve hierarchical indentation via a simple style attribute if present
          const indentMatch = child.className.match(/sb-line-li-(\d+)/);
          const padding = indentMatch ? parseInt(indentMatch[1]) * 20 : 0;

          // Wrap in a div to preserve line breaks and indentation
          output.push(
            `<div style="padding-left: ${padding}px">${clone.innerHTML}</div>`
          );
        }
      }

      return output.join("\n");
    });

    if (!content) {
      throw new Error(
        `No content extracted from "#sb-editor .cm-content" for "${filename}" — ` +
          `the page may not exist or the selector has changed`
      );
    }

    console.log(
      `[readNoteRendered] DONE "${filename}" — ${content.length} chars in ${Date.now() - t0}ms`
    );
    return content;
  } finally {
    await context.close();
  }
}
