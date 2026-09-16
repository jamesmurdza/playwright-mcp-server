import { mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { uploadRecording, uploadScreenshot, type UploadResult } from "./bucket.js";

export class BrowserSessionError extends Error {}

const REF_PATTERN = /^e\d+$/;

/**
 * One Playwright browser per MCP session, as agreed for v1: no pooling, no
 * manager, no concurrent sessions. If a client wants a second browser it
 * must call browser_end() first.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly videoDir: string;
  private started = false;
  private ended = false;
  private screenshotCount = 0;

  constructor(private readonly sessionId: string) {
    this.videoDir = path.join("/tmp/videos", sessionId);
  }

  async start(): Promise<{ status: "started" }> {
    if (this.started) {
      throw new BrowserSessionError(
        "A browser session is already running for this MCP session. Call browser_end() before starting a new one.",
      );
    }
    this.started = true;

    await mkdir(this.videoDir, { recursive: true });
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      recordVideo: { dir: this.videoDir },
    });
    this.page = await this.context.newPage();

    return { status: "started" };
  }

  private assertActive(): Page {
    if (!this.started || this.ended || !this.page) {
      throw new BrowserSessionError(
        "No active browser session. Call browser_start() first.",
      );
    }
    return this.page;
  }

  private locatorFor(page: Page, ref: string) {
    if (!REF_PATTERN.test(ref)) {
      throw new BrowserSessionError(
        `Invalid ref "${ref}". Refs come from browser_snapshot() and look like "e3".`,
      );
    }
    return page.locator(`[data-mcp-ref="${ref}"]`);
  }

  /**
   * Waits for an in-flight navigation to settle, bounded by a short
   * timeout. Playwright's click()/fill() only wait for a navigation to
   * *start* if the action triggers one (e.g. a form submit), not for it
   * to finish -- so a screenshot taken right after can land mid-transition
   * and fail. Best-effort: ignored on timeout so it never stalls an action
   * that didn't navigate, or blocks one that's slow to settle.
   */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  }

  /**
   * Screenshots a step and uploads it, mirroring how browser_end() ships
   * the video recording. Never throws: a screenshot (or its upload) is a
   * bonus on top of navigate/click/type, not the point of the call, so a
   * failure here -- most commonly no bucket configured, which is fine for
   * local dev -- just means this step's result omits `screenshot` rather
   * than failing the underlying browser action.
   */
  private async captureScreenshot(page: Page): Promise<UploadResult | null> {
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
      const key = `${this.sessionId}-${++this.screenshotCount}.jpg`;
      return await uploadScreenshot(buffer, key);
    } catch (error) {
      console.error("[browser-session] screenshot upload failed:", error);
      return null;
    }
  }

  async navigate(url: string) {
    const page = this.assertActive();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    // goto() only waits for *this* navigation. If the destination page
    // immediately kicks off another one (client-side redirect, meta
    // refresh, SPA routing), the screenshot below could still race it.
    await this.settle(page);
    return {
      url: page.url(),
      status: response ? response.status() : null,
      title: await page.title(),
      screenshot: await this.captureScreenshot(page),
    };
  }

  async snapshot() {
    const page = this.assertActive();
    const tree = await captureSnapshot(page);
    return {
      url: page.url(),
      title: await page.title(),
      snapshot: tree,
    };
  }

  async click(ref: string) {
    const page = this.assertActive();
    const locator = this.locatorFor(page, ref);
    if ((await locator.count()) === 0) {
      throw new BrowserSessionError(
        `No element found for ref "${ref}". Call browser_snapshot() again to get fresh refs.`,
      );
    }
    await locator.first().click();
    await this.settle(page);
    return { clicked: ref, screenshot: await this.captureScreenshot(page) };
  }

  async type(ref: string, text: string) {
    const page = this.assertActive();
    const locator = this.locatorFor(page, ref);
    if ((await locator.count()) === 0) {
      throw new BrowserSessionError(
        `No element found for ref "${ref}". Call browser_snapshot() again to get fresh refs.`,
      );
    }
    const el = locator.first();
    try {
      await el.fill(text);
    } catch {
      // Not a fillable form control (e.g. contenteditable) -- fall back to
      // clicking and typing character by character.
      await el.click();
      await el.pressSequentially(text);
    }
    await this.settle(page);
    return { typed: ref, screenshot: await this.captureScreenshot(page) };
  }

  async end(): Promise<{ recording: UploadResult | null }> {
    if (!this.started || this.ended) {
      throw new BrowserSessionError("No active browser session to end.");
    }
    this.ended = true;

    const page = this.page!;
    const context = this.context!;
    const browser = this.browser!;

    // Must grab the Video handle before closing the context.
    const video = page.video();

    try {
      await context.close();

      let recording: UploadResult | null = null;
      if (video) {
        const videoPath = await video.path();
        try {
          const key = `${this.sessionId}-${path.basename(videoPath)}`;
          recording = await uploadRecording(videoPath, key);
        } finally {
          await unlink(videoPath).catch(() => {});
        }
      }

      return { recording };
    } finally {
      // Always release the browser process and temp dir, even if the
      // upload (or context.close()) threw -- otherwise a failed upload
      // leaks Chromium and permanently wedges this MCP session, since
      // `ended` is already true and dispose() won't touch it.
      await browser.close().catch(() => {});
      await rm(this.videoDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Best-effort cleanup when an MCP session disconnects without calling browser_end(). */
  async dispose(): Promise<void> {
    if (this.started && !this.ended) {
      this.ended = true;
      await this.context?.close().catch(() => {});
      await this.browser?.close().catch(() => {});
      await rm(this.videoDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Builds a compact, indented accessibility-style tree of the page. Every
 * interactive element gets a stable `data-mcp-ref` attribute (e.g. "e3") so
 * that browser_click/browser_type can target it without a CSS selector or a
 * screenshot + coordinates round trip.
 */
async function captureSnapshot(page: Page, maxNodes = 400): Promise<string> {
  return page.evaluate((maxNodes) => {
    const INTERACTIVE_ROLES = new Set([
      "button",
      "link",
      "textbox",
      "searchbox",
      "checkbox",
      "radio",
      "combobox",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
    ]);

    const SKIP_TAGS = new Set([
      "script",
      "style",
      "noscript",
      "template",
      "meta",
      "link",
      "head",
      "svg",
    ]);

    function truncate(value: string, max: number): string {
      const trimmed = value.replace(/\s+/g, " ").trim();
      return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
    }

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      if (el.hasAttribute("hidden")) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0 && el.tagName.toLowerCase() !== "body") {
        return false;
      }
      return true;
    }

    function roleForInput(el: Element): string {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const map: Record<string, string> = {
        button: "button",
        submit: "button",
        reset: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
        hidden: "hidden",
      };
      return map[type] ?? "textbox";
    }

    function computeRole(el: Element): string {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      switch (tag) {
        case "a":
          return el.hasAttribute("href") ? "link" : "generic";
        case "button":
          return "button";
        case "input":
          return roleForInput(el);
        case "select":
          return "combobox";
        case "textarea":
          return "textbox";
        case "img":
          return "img";
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return "heading";
        case "nav":
          return "navigation";
        case "main":
          return "main";
        case "header":
          return "banner";
        case "footer":
          return "contentinfo";
        case "ul":
        case "ol":
          return "list";
        case "li":
          return "listitem";
        case "table":
          return "table";
        case "form":
          return "form";
        default:
          return tag;
      }
    }

    function labelFromFor(el: Element): string | null {
      const id = el.getAttribute("id");
      if (!id) return null;
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      return label ? label.textContent : null;
    }

    function computeName(el: Element, role: string): string {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel;

      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }

      const tag = el.tagName.toLowerCase();
      if (tag === "img") {
        return el.getAttribute("alt") ?? "";
      }
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const fromLabel = labelFromFor(el) ?? el.closest("label")?.textContent ?? null;
        if (fromLabel) return fromLabel;
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) return placeholder;
        if (tag === "input") {
          const value = (el as HTMLInputElement).value;
          if (value) return value;
        }
      }

      const title = el.getAttribute("title");
      if (title) return title;

      return (el.textContent || "").trim();
    }

    function isInteractive(el: Element, role: string): boolean {
      const tag = el.tagName.toLowerCase();
      if (tag === "a" && el.hasAttribute("href")) return true;
      if (tag === "input") return roleForInput(el) !== "hidden";
      if (tag === "button" || tag === "select" || tag === "textarea") return true;
      if (INTERACTIVE_ROLES.has(role)) return true;
      if (el.hasAttribute("onclick")) return true;
      const tabindex = el.getAttribute("tabindex");
      if (tabindex !== null && tabindex !== "-1") return true;
      const editable = el.getAttribute("contenteditable");
      if (editable === "" || editable === "true") return true;
      return false;
    }

    document.querySelectorAll("[data-mcp-ref]").forEach((el) => el.removeAttribute("data-mcp-ref"));

    let refCounter = 0;
    let emitted = 0;
    const lines: string[] = [];

    function walk(el: Element, depth: number): void {
      if (emitted >= maxNodes) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (!isVisible(el)) return;

      const role = computeRole(el);
      const interactive = isInteractive(el, role);
      let ref: string | null = null;
      if (interactive) {
        ref = `e${++refCounter}`;
        el.setAttribute("data-mcp-ref", ref);
      }

      const children = Array.from(el.children);
      const isHeading = /^h[1-6]$/.test(tag);
      const ownText = (el.textContent || "").trim();
      const isLeafText = children.length === 0 && ownText.length > 0;
      const shouldEmit = interactive || isHeading || role === "img" || (isLeafText && tag !== "body");

      let childDepth = depth;
      if (shouldEmit) {
        const name = computeName(el, role);
        const namePart = name ? ` "${truncate(name, 100)}"` : "";
        const refPart = ref ? ` [ref=${ref}]` : "";
        lines.push(`${"  ".repeat(depth)}- ${role}${namePart}${refPart}`);
        emitted++;
        childDepth = depth + 1;
      }

      if (emitted >= maxNodes) {
        lines.push(`${"  ".repeat(childDepth)}- … (truncated, page has more content)`);
        return;
      }

      for (const child of children) walk(child, childDepth);
    }

    walk(document.body, 0);
    return lines.join("\n") || "(empty page)";
  }, maxNodes);
}
