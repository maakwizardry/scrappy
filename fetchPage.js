/**
 * fetchPage.js
 *
 * Shared page-fetching helper used by urlValidator.js and enrichment.js.
 *
 * Many small-business sites sit behind bot-protection (Cloudflare/WAF) that
 * blocks plain axios requests with a 403, or are client-rendered (React/Wix/
 * Squarespace) and return an almost-empty HTML shell until JS runs. A plain
 * axios fetch alone misclassifies these as dead/no-website. This helper
 * tries axios first (cheap/fast) and falls back to a headless Playwright
 * render only when axios looks blocked or empty, recovering real content.
 */

const axios = require("axios");
const { chromium } = require("playwright");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": BROWSER_UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// A page is treated as "looks blocked/empty" -> worth a Playwright retry.
const EMPTY_PAGE_THRESHOLD = 200;

// Signatures of a block/challenge page served instead of real content —
// some hosts IP-block datacenter traffic outright, which a headless browser
// render can't get around. Don't let these masquerade as "real content".
const BLOCK_PAGE_PATTERNS = [
  /\b403\b.{0,20}forbidden/i,
  /access denied/i,
  /attention required/i,
  /just a moment/i,
  /checking your browser/i,
  /cf-error-details/i,
  /captcha/i,
  /request blocked/i,
  /you have been blocked/i,
];

function looksLikeBlockPage(html, statusCode) {
  if (statusCode === 403 || statusCode === 429) {
    const head = (html || "").slice(0, 3000);
    if (BLOCK_PAGE_PATTERNS.some((p) => p.test(head))) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// Shared headless browser (lazy singleton, reused across calls)
// ─────────────────────────────────────────────
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      browserPromise = null; // allow retry on next call
      throw err;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close().catch(() => {});
    browserPromise = null;
  }
}

// ─────────────────────────────────────────────
// axios attempt (with one retry on transient network errors)
// ─────────────────────────────────────────────
async function fetchWithAxios(url, { timeout = 12000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout,
        maxRedirects: 5,
        headers: BROWSER_HEADERS,
        validateStatus: (s) => s < 500,
      });
      return {
        ok: true,
        statusCode: response.status,
        html: typeof response.data === "string" ? response.data : "",
        finalUrl: response.request?.res?.responseUrl || url,
        headers: response.headers || {},
      };
    } catch (err) {
      lastErr = err;
      const transient =
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "EAI_AGAIN" ||
        (err.message || "").includes("timeout");
      if (transient && attempt < retries) {
        await delay(1500 + attempt * 1500);
        continue;
      }
      break;
    }
  }
  return { ok: false, error: lastErr };
}

// ─────────────────────────────────────────────
// Playwright fallback (real browser render — bypasses many WAFs, executes JS)
// ─────────────────────────────────────────────
async function fetchWithPlaywright(url, { timeout = 20000 } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: BROWSER_UA,
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(1500); // let client-side JS populate the DOM
    const html = await page.content();
    return {
      ok: true,
      statusCode: response ? response.status() : 200,
      html,
      finalUrl: page.url(),
      headers: response ? await response.headers() : {},
      viaPlaywright: true,
    };
  } catch (err) {
    return { ok: false, error: err, viaPlaywright: true };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Fetch a page, transparently falling back to a headless-browser render
 * when the plain HTTP fetch looks blocked (403/429) or empty (client-rendered
 * site with no server-side HTML).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   statusCode: number|null,
 *   html: string,
 *   finalUrl: string,
 *   viaPlaywright: boolean,
 *   error?: Error,
 * }>}
 */
async function fetchWithFallback(url, opts = {}) {
  const axiosResult = await fetchWithAxios(url, opts);

  const looksBlocked =
    axiosResult.ok && (axiosResult.statusCode === 403 || axiosResult.statusCode === 429);
  const looksEmpty =
    axiosResult.ok &&
    axiosResult.statusCode < 400 &&
    (!axiosResult.html || axiosResult.html.trim().length < EMPTY_PAGE_THRESHOLD);
  const networkFailure = !axiosResult.ok;

  if (!looksBlocked && !looksEmpty && !networkFailure) {
    return { ...axiosResult, viaPlaywright: false };
  }

  // Fall back to a real browser render
  const pwResult = await fetchWithPlaywright(url, opts);

  const pwHasContent = pwResult.ok && pwResult.html && pwResult.html.trim().length >= EMPTY_PAGE_THRESHOLD;
  const pwIsBlockPage = pwHasContent && looksLikeBlockPage(pwResult.html, pwResult.statusCode);

  if (pwHasContent && !pwIsBlockPage) {
    return pwResult;
  }

  // Playwright didn't help either (still blocked, or a block/challenge page
  // rendered instead of real content) — return whichever attempt has more signal
  if (axiosResult.ok) return { ...axiosResult, viaPlaywright: false };
  return { ok: false, error: pwResult.error || axiosResult.error, viaPlaywright: true };
}

module.exports = { fetchWithFallback, closeBrowser };
