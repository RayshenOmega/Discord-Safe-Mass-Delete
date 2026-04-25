// ==UserScript==
// @name         Discord Safe Mass Delete
// @namespace    local.discord.safe.delete
// @version      1.0.2
// @author       Rayshen
// @description  Mass delete your own Discord messages with conservative rate-limit handling.
// @homepageURL  https://github.com/RayshenOmega
// @supportURL   https://github.com/RayshenOmega
// @match        https://discord.com/channels/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const API_BASE = "https://discord.com/api/v10";

  const state = {
    running: false,
    cancelled: false
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function parseScanLimit(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.max(1, Math.floor(n));
  }

  function detectChannelIdFromUrl() {
    const match = location.pathname.match(/^\/channels\/[^/]+\/([0-9]{15,25})$/);
    return match ? match[1] : "";
  }

  function detectGuildIdFromUrl() {
    const match = location.pathname.match(/^\/channels\/([^/]+)\/([0-9]{15,25})$/);
    if (!match || match[1] === "@me") return "";
    return match[1];
  }

  // Convert a JS Date to a Discord snowflake string for use as a `before` cursor.
  function dateToSnowflake(date) {
    const DISCORD_EPOCH = 1420070400000n;
    const ms = BigInt(Math.floor(date.getTime()));
    return String((ms - DISCORD_EPOCH) << 22n);
  }

  async function parseRetryAfterMs(response) {
    try {
      const data = await response.clone().json();
      if (typeof data?.retry_after === "number") {
        return Math.ceil(data.retry_after * 1000);
      }
    } catch {
      // Ignore parse errors.
    }

    const retryAfterHeader = response.headers.get("retry-after");
    if (!retryAfterHeader) return null;

    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) {
      return Math.ceil(seconds * 1000);
    }

    return null;
  }

  async function discordRequest(token, method, path, maxRetries, setStatus) {
    const url = `${API_BASE}${path}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (state.cancelled) {
        throw new Error("Operation cancelled.");
      }

      try {
        const response = await fetch(url, {
          method,
          credentials: "include",
          headers: {
            Authorization: token,
            "Content-Type": "application/json"
          }
        });

        if (response.status === 429) {
          const retryAfter = (await parseRetryAfterMs(response)) ?? 1500;
          const waitMs = retryAfter + randomInt(100, 250);
          setStatus(`Rate limited. Waiting ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }

        if (response.status >= 500 && response.status <= 599) {
          if (attempt === maxRetries) return response;
          const waitMs = Math.min(5000, 350 * (attempt + 1)) + randomInt(80, 200);
          setStatus(`Discord server error. Retry in ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }

        return response;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        const waitMs = Math.min(5000, 300 * (attempt + 1)) + randomInt(80, 200);
        setStatus(`Network error. Retry in ${waitMs}ms...`);
        await sleep(waitMs);
      }
    }

    throw new Error("Request retry loop exhausted.");
  }

  async function fetchCurrentUser(token, maxRetries, setStatus) {
    const response = await discordRequest(token, "GET", "/users/@me", maxRetries, setStatus);
    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      if (response.status === 401) {
        throw new Error("Could not read current user (401). Check token format, account, and validity.");
      }
      throw new Error(`Could not read current user (${response.status}): ${body}`);
    }
    return response.json();
  }

  async function fetchGuildChannels(token, guildId, maxRetries, setStatus) {
    const response = await discordRequest(token, "GET", `/guilds/${guildId}/channels`, maxRetries, setStatus);

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      throw new Error(`Failed to fetch guild channels (${response.status}): ${body}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    const channelTypesToScan = new Set([0, 5, 10, 11, 12]);

    return data
      .filter(channel => channel && channelTypesToScan.has(channel.type))
      .sort((a, b) => {
        const aPos = Number.isFinite(a?.position) ? a.position : 0;
        const bPos = Number.isFinite(b?.position) ? b.position : 0;
        return aPos - bPos;
      });
  }

  async function searchGuildMessages(token, guildId, authorId, offset, maxRetries, setStatus) {
    const qs = new URLSearchParams({
      author_id: authorId,
      offset: String(offset),
      include_nsfw: "true"
    });

    const response = await discordRequest(
      token,
      "GET",
      `/guilds/${guildId}/messages/search?${qs.toString()}`,
      maxRetries,
      setStatus
    );

    if (response.status === 202) {
      const retryAfter = (await parseRetryAfterMs(response)) ?? 2000;
      setStatus(`Building guild search index. Waiting ${retryAfter}ms...`);
      await sleep(retryAfter + randomInt(100, 250));
      return searchGuildMessages(token, guildId, authorId, offset, maxRetries, setStatus);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      throw new Error(`Failed to search guild messages (${response.status}): ${body}`);
    }

    const data = await response.json();
    const groups = Array.isArray(data?.messages) ? data.messages : [];
    const messages = groups
      .map(group => Array.isArray(group)
        ? (group.find(item => item?.hit) || group[0])
        : group)
      .filter(Boolean);

    return {
      totalResults: Number(data?.total_results) || 0,
      messages
    };
  }

  async function fetchMessages(token, channelId, before, maxRetries, setStatus) {
    const qs = new URLSearchParams({ limit: "100" });
    if (before) qs.set("before", before);

    const response = await discordRequest(
      token,
      "GET",
      `/channels/${channelId}/messages?${qs.toString()}`,
      maxRetries,
      setStatus
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      throw new Error(`Failed to fetch messages (${response.status}): ${body}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  function shouldSkipDeleteError(responseStatus, responseCode, opts) {
    if (responseStatus === 404 && opts.skipUnknownMessage) return "Skipping unknown message.";
    if (responseStatus === 403 && opts.skipMissingPermissions) return "Skipping message due to missing permissions.";
    if (responseCode === 50083 && opts.skipArchivedThreads) return "Skipping archived thread message.";
    if (responseCode === 160005 && opts.skipLockedThreads) return "Skipping locked thread message.";
    return null;
  }

  async function deleteMessage(token, channelId, messageId, maxRetries, setStatus, opts) {
    const response = await discordRequest(
      token,
      "DELETE",
      `/channels/${channelId}/messages/${messageId}`,
      maxRetries,
      setStatus
    );

    if (response.ok) {
      return true;
    }

    const body = await response.text().catch(() => "<no body>");
    let responseCode = null;
    if (body && body !== "<no body>") {
      try {
        responseCode = JSON.parse(body)?.code ?? null;
      } catch {
        responseCode = null;
      }
    }

    const skipReason = shouldSkipDeleteError(response.status, responseCode, opts);
    if (skipReason) {
      setStatus(skipReason);
      return false;
    }

    throw new Error(`Delete failed (${response.status}): ${body}`);
  }

  async function purgeChannelMessages(token, userId, channelId, channelName, opts, totals, setStatus) {
    let before = (opts.useDate && opts.dateTo) ? dateToSnowflake(opts.dateTo) : null;

    while (totals.scanned < opts.scanLimit && totals.deleted < opts.limit) {
      if (state.cancelled) throw new Error("Operation cancelled.");

      const page = await fetchMessages(token, channelId, before, opts.maxRetries, setStatus);
      if (page.length === 0) break;

      totals.scanned += page.length;

      let stopScan = false;
      for (const message of page) {
        if (state.cancelled) throw new Error("Operation cancelled.");
        if (totals.deleted >= opts.limit) break;

        if (opts.useDate) {
          const msgTime = message.timestamp ? new Date(message.timestamp).getTime() : null;
          if (msgTime !== null) {
            if (opts.dateFrom && msgTime < opts.dateFrom.getTime()) {
              stopScan = true;
              break;
            }
            if (opts.dateTo && msgTime > opts.dateTo.getTime()) continue;
          }
        }

        if (opts.serverWide) {
          if (message?.author?.id !== userId) continue;
        } else if (opts.useUserId && opts.filterUserIds.length > 0) {
          if (!opts.filterUserIds.includes(message?.author?.id)) continue;
        } else if (!opts.deleteAll && message?.author?.id !== userId) {
          continue;
        }

        totals.matched++;

        if (!opts.dryRun) {
          const spacing = opts.minDelayMs + randomInt(0, opts.jitterMs);
          await sleep(spacing);

          const ok = await deleteMessage(token, channelId, message.id, opts.maxRetries, setStatus, opts);
          if (ok) {
            totals.deleted++;
            totals.sinceBurst++;
          } else {
            totals.failed++;
          }

          if (totals.sinceBurst >= opts.burstCount) {
            await sleep(opts.burstPauseMs + randomInt(60, 220));
            totals.sinceBurst = 0;
          }
        }

        setStatus(
          [
            opts.dryRun ? "Scanning..." : "Deleting...",
            `Scope: ${opts.serverWide ? `Server (${totals.channelsVisited}/${totals.channelsTotal})` : "Channel"}`,
            `Current: ${channelName || channelId}`,
            `Scanned: ${totals.scanned}`,
            `Matched: ${totals.matched}`,
            `Deleted: ${opts.dryRun ? totals.matched : totals.deleted}`,
            `Failed: ${totals.failed}`
          ].join("\n")
        );
      }

      if (stopScan) break;
      before = page[page.length - 1]?.id ?? null;
      if (page.length < 100) break;
    }
  }

  async function purgeGuildSearchMessages(token, userId, opts, totals, setStatus) {
    const authorId = opts.useUserId && opts.filterUserIds.length === 1
      ? opts.filterUserIds[0]
      : userId;

    let offset = 0;
    let stalePageCount = 0;
    const seenMessageIds = new Set();

    while (totals.scanned < opts.scanLimit && totals.deleted < opts.limit) {
      if (state.cancelled) throw new Error("Operation cancelled.");

      const search = await searchGuildMessages(token, opts.guildId, authorId, offset, opts.maxRetries, setStatus);
      const page = search.messages;
      if (page.length === 0) break;

      let pageHasNewMessages = false;
      let pageMatched = false;

      for (const message of page) {
        if (!message?.id || seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        pageHasNewMessages = true;

        if (state.cancelled) throw new Error("Operation cancelled.");
        if (totals.deleted >= opts.limit) break;
        if (totals.scanned >= opts.scanLimit) break;

        totals.scanned++;

        if (opts.useDate) {
          const msgTime = message.timestamp ? new Date(message.timestamp).getTime() : null;
          if (msgTime !== null) {
            if (opts.dateFrom && msgTime < opts.dateFrom.getTime()) continue;
            if (opts.dateTo && msgTime > opts.dateTo.getTime()) continue;
          }
        }

        if (opts.useUserId && opts.filterUserIds.length > 0 && !opts.filterUserIds.includes(message?.author?.id)) {
          continue;
        }

        totals.matched++;
        pageMatched = true;

        if (!opts.dryRun) {
          const spacing = opts.minDelayMs + randomInt(0, opts.jitterMs);
          await sleep(spacing);

          const ok = await deleteMessage(token, message.channel_id, message.id, opts.maxRetries, setStatus, opts);
          if (ok) {
            totals.deleted++;
            totals.sinceBurst++;
          } else {
            totals.failed++;
          }

          if (totals.sinceBurst >= opts.burstCount) {
            await sleep(opts.burstPauseMs + randomInt(60, 220));
            totals.sinceBurst = 0;
          }
        }

        setStatus(
          [
            opts.dryRun ? "Scanning server..." : "Deleting across server...",
            `Scope: Server search`,
            `Scanned: ${totals.scanned}`,
            `Matched: ${totals.matched}`,
            `Deleted: ${opts.dryRun ? totals.matched : totals.deleted}`,
            `Failed: ${totals.failed}`
          ].join("\n")
        );
      }

      if (!pageHasNewMessages) {
        stalePageCount++;
      } else {
        stalePageCount = 0;
      }

      if (opts.dryRun || !pageMatched) {
        offset += page.length;
        if (offset >= search.totalResults) break;
      } else {
        offset = 0;
      }

      if (stalePageCount >= 8) {
        setStatus("Search results stopped progressing. Ending to avoid infinite loop.");
        break;
      }
    }
  }

  function createUi() {
    const wrap = document.createElement("div");
    wrap.id = "dsmd-panel";
    wrap.innerHTML = `
      <div class="dsmd-title">Safe Mass Delete</div>
      <label>Discord token</label>
      <input id="dsmd-token" type="password" placeholder="Paste token" />
      <label>Channel ID</label>
      <input id="dsmd-channelId" type="text" placeholder="123456789012345678" />
      <button id="dsmd-detect" type="button">Detect Channel From URL</button>
      <label class="dsmd-check"><input id="dsmd-serverWide" type="checkbox" />Delete my messages across current server</label>
      <label>Delete limit</label>
      <input id="dsmd-limit" type="number" min="1" max="5000" value="100" />
      <label class="dsmd-check"><input id="dsmd-deleteAll" type="checkbox" />Delete ALL messages in channel</label>
      <label class="dsmd-check"><input id="dsmd-useDate" type="checkbox" />Filter by date range</label>
      <div id="dsmd-dateRange" class="dsmd-filter-section" style="display:none">
        <label>From (local time)</label>
        <input id="dsmd-dateFrom" type="datetime-local" />
        <label>To (local time)</label>
        <input id="dsmd-dateTo" type="datetime-local" />
      </div>
      <label class="dsmd-check"><input id="dsmd-useUserId" type="checkbox" />Filter by user ID(s)</label>
      <div id="dsmd-userIdSection" class="dsmd-filter-section" style="display:none">
        <label>User IDs (comma or space separated)</label>
        <input id="dsmd-userIds" type="text" placeholder="123456789, 987654321" />
      </div>
      <label class="dsmd-check"><input id="dsmd-dryRun" type="checkbox" checked />Dry run only</label>
      <label>Confirm token (required for real delete)</label>
      <input id="dsmd-confirm" type="text" placeholder="Type DELETE" />
      <details>
        <summary>Advanced safety controls</summary>
        <label>Scan limit (0 = unlimited)</label>
        <input id="dsmd-scanLimit" type="number" min="0" value="0" />
        <label>Min delay ms</label>
        <input id="dsmd-minDelayMs" type="number" min="250" max="8000" value="850" />
        <label>Jitter ms</label>
        <input id="dsmd-jitterMs" type="number" min="0" max="5000" value="250" />
        <label>Burst count</label>
        <input id="dsmd-burstCount" type="number" min="1" max="100" value="6" />
        <label>Burst pause ms</label>
        <input id="dsmd-burstPauseMs" type="number" min="0" max="15000" value="2200" />
        <label>Max retries</label>
        <input id="dsmd-maxRetries" type="number" min="0" max="20" value="5" />
        <div class="dsmd-filter-section">
          <label class="dsmd-check"><input id="dsmd-skipArchivedThreads" type="checkbox" checked />Skip archived threads</label>
          <label class="dsmd-check"><input id="dsmd-skipLockedThreads" type="checkbox" checked />Skip locked threads</label>
          <label class="dsmd-check"><input id="dsmd-skipMissingPermissions" type="checkbox" checked />Skip missing permissions</label>
          <label class="dsmd-check"><input id="dsmd-skipUnknownMessage" type="checkbox" checked />Skip unknown messages</label>
        </div>
      </details>
      <div class="dsmd-actions">
        <button id="dsmd-start" type="button">Start</button>
        <button id="dsmd-cancel" type="button" disabled>Cancel</button>
      </div>
      <pre id="dsmd-status">Idle</pre>
    `;

    const style = document.createElement("style");
    style.textContent = `
      /* ── Toolbar toggle button ── */
      #dsmd-toggle-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        margin: 0 4px;
        flex-shrink: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--interactive-normal, #8e9297);
        cursor: pointer;
        vertical-align: middle;
      }
      #dsmd-toggle-btn:hover {
        background: var(--background-modifier-hover, rgba(79,84,92,0.16));
        color: var(--interactive-hover, #dcddde);
      }
      #dsmd-toggle-btn.dsmd-active {
        color: var(--interactive-active, #fff);
        background: var(--background-modifier-selected, rgba(79,84,92,0.32));
      }

      /* ── Panel light-mode defaults (CSS vars) ── */
      #dsmd-panel {
        --dsmd-bg: #f8f9fb;
        --dsmd-border: #cfd4dd;
        --dsmd-text: #111;
        --dsmd-input-bg: #ffffff;
        --dsmd-input-color: #111;
        --dsmd-surface: #ffffff;
        --dsmd-surface-border: #d6dbe4;
        --dsmd-cancel: #5f6368;
      }
      /* ── Dark mode overrides ── */
      #dsmd-panel.dsmd-dark {
        --dsmd-bg: #2b2d31;
        --dsmd-border: #3a3d44;
        --dsmd-text: #dbdee1;
        --dsmd-input-bg: #383a40;
        --dsmd-input-color: #dbdee1;
        --dsmd-surface: #1e1f22;
        --dsmd-surface-border: #3a3d44;
        --dsmd-cancel: #4e5058;
      }
      /* ── Panel layout ── */
      #dsmd-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 320px;
        z-index: 2147483647;
        background: var(--dsmd-bg);
        border: 1px solid var(--dsmd-border);
        border-radius: 10px;
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.25);
        padding: 10px;
        color: var(--dsmd-text);
        font: 12px/1.3 Segoe UI, sans-serif;
      }
      #dsmd-panel * {
        box-sizing: border-box;
      }
      #dsmd-panel label {
        display: block;
        margin: 8px 0 4px;
      }
      #dsmd-panel input,
      #dsmd-panel button {
        width: 100%;
        border-radius: 7px;
        border: 1px solid var(--dsmd-border);
        padding: 7px;
        font: inherit;
      }
      #dsmd-panel input {
        background: var(--dsmd-input-bg);
        color: var(--dsmd-input-color);
      }
      #dsmd-panel input::placeholder {
        color: var(--dsmd-input-color);
        opacity: 0.5;
      }
      #dsmd-panel button {
        cursor: pointer;
        background: #1163bf;
        color: #fff;
        border: none;
        font-weight: 600;
      }
      #dsmd-panel button:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }
      #dsmd-panel .dsmd-title {
        font-size: 14px;
        font-weight: 700;
        margin-bottom: 6px;
      }
      #dsmd-panel .dsmd-check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 10px;
      }
      #dsmd-panel .dsmd-check input {
        width: auto;
      }
      #dsmd-panel details {
        margin-top: 8px;
        border: 1px solid var(--dsmd-surface-border);
        border-radius: 8px;
        padding: 6px;
        background: var(--dsmd-surface);
      }
      #dsmd-panel summary {
        cursor: pointer;
        font-weight: 600;
      }
      #dsmd-panel .dsmd-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      #dsmd-panel .dsmd-actions button {
        flex: 1;
      }
      #dsmd-panel #dsmd-cancel {
        background: var(--dsmd-cancel);
      }
      #dsmd-panel .dsmd-filter-section {
        margin-top: 6px;
        border: 1px solid var(--dsmd-surface-border);
        border-radius: 8px;
        padding: 6px 8px;
        background: var(--dsmd-surface);
      }
      #dsmd-panel pre {
        margin: 10px 0 0;
        border: 1px solid var(--dsmd-surface-border);
        border-radius: 8px;
        background: var(--dsmd-surface);
        color: var(--dsmd-text);
        padding: 7px;
        max-height: 140px;
        overflow: auto;
        white-space: pre-wrap;
      }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(wrap);
    return wrap;
  }

  function bindUi(root) {
    const el = {
      token: root.querySelector("#dsmd-token"),
      channelId: root.querySelector("#dsmd-channelId"),
      detect: root.querySelector("#dsmd-detect"),
      serverWide: root.querySelector("#dsmd-serverWide"),
      limit: root.querySelector("#dsmd-limit"),
      deleteAll: root.querySelector("#dsmd-deleteAll"),
      useDate: root.querySelector("#dsmd-useDate"),
      dateRange: root.querySelector("#dsmd-dateRange"),
      dateFrom: root.querySelector("#dsmd-dateFrom"),
      dateTo: root.querySelector("#dsmd-dateTo"),
      useUserId: root.querySelector("#dsmd-useUserId"),
      userIdSection: root.querySelector("#dsmd-userIdSection"),
      userIds: root.querySelector("#dsmd-userIds"),
      dryRun: root.querySelector("#dsmd-dryRun"),
      confirm: root.querySelector("#dsmd-confirm"),
      scanLimit: root.querySelector("#dsmd-scanLimit"),
      minDelayMs: root.querySelector("#dsmd-minDelayMs"),
      jitterMs: root.querySelector("#dsmd-jitterMs"),
      burstCount: root.querySelector("#dsmd-burstCount"),
      burstPauseMs: root.querySelector("#dsmd-burstPauseMs"),
      maxRetries: root.querySelector("#dsmd-maxRetries"),
      skipArchivedThreads: root.querySelector("#dsmd-skipArchivedThreads"),
      skipLockedThreads: root.querySelector("#dsmd-skipLockedThreads"),
      skipMissingPermissions: root.querySelector("#dsmd-skipMissingPermissions"),
      skipUnknownMessage: root.querySelector("#dsmd-skipUnknownMessage"),
      start: root.querySelector("#dsmd-start"),
      cancel: root.querySelector("#dsmd-cancel"),
      status: root.querySelector("#dsmd-status")
    };

    const setStatus = (text) => {
      el.status.textContent = text;
    };

    const detected = detectChannelIdFromUrl();
    if (detected) el.channelId.value = detected;

    el.detect.addEventListener("click", () => {
      const id = detectChannelIdFromUrl();
      if (!id) {
        setStatus("Could not detect channel. Open a channel page and try again.");
        return;
      }
      el.channelId.value = id;
      setStatus(`Detected channel ID: ${id}`);
    });

    el.serverWide.addEventListener("change", () => {
      const disabled = el.serverWide.checked;
      el.channelId.disabled = disabled;
      el.detect.disabled = disabled;
      if (disabled) {
        const guildId = detectGuildIdFromUrl();
        setStatus(guildId ? `Server-wide mode enabled for guild ${guildId}.` : "Server-wide mode requires opening a server channel.");
      }
    });

    el.deleteAll.addEventListener("change", () => {
      el.limit.disabled = el.deleteAll.checked;
    });

    el.useDate.addEventListener("change", () => {
      el.dateRange.style.display = el.useDate.checked ? "block" : "none";
    });

    el.useUserId.addEventListener("change", () => {
      el.userIdSection.style.display = el.useUserId.checked ? "block" : "none";
    });

    el.cancel.addEventListener("click", () => {
      if (!state.running) return;
      state.cancelled = true;
      setStatus("Cancelling...");
    });

    el.start.addEventListener("click", async () => {
      if (state.running) return;

      const dryRun = Boolean(el.dryRun.checked);
      const deleteAll = Boolean(el.deleteAll.checked);
      const serverWide = Boolean(el.serverWide.checked);
      const limit = deleteAll ? Number.MAX_SAFE_INTEGER : clampInt(el.limit.value, 100, 1, 5000);
      const token = String(el.token.value || "").trim().replace(/^"|"$/g, "");
      const channelId = String(el.channelId.value || "").trim();
      const guildId = detectGuildIdFromUrl();
      const confirm = String(el.confirm.value || "").trim();

      if (!token) {
        setStatus("Token is required.");
        return;
      }

      if (!serverWide && !channelId) {
        setStatus("Channel ID is required.");
        return;
      }

      if (serverWide && !guildId) {
        setStatus("Server-wide mode requires an open guild channel, not DMs.");
        return;
      }

      if (!dryRun && confirm !== "DELETE") {
        setStatus("For real delete, type DELETE in confirm.");
        return;
      }

      const useDate = Boolean(el.useDate.checked);
      const dateFrom = useDate && el.dateFrom.value ? new Date(el.dateFrom.value) : null;
      const dateTo = useDate && el.dateTo.value ? new Date(el.dateTo.value) : null;

      if (useDate && dateFrom && dateTo && dateFrom > dateTo) {
        setStatus("Date range error: From must be before To.");
        return;
      }

      const useUserId = Boolean(el.useUserId.checked);
      const filterUserIds = useUserId
        ? String(el.userIds.value).split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
        : [];

      if (useUserId && filterUserIds.length === 0) {
        setStatus("User ID filter is enabled but no IDs were entered.");
        return;
      }

      const opts = {
        limit,
        deleteAll,
        serverWide,
        guildId,
        channelId,
        dryRun,
        useDate,
        dateFrom,
        dateTo,
        useUserId,
        filterUserIds,
        scanLimit: deleteAll ? Number.MAX_SAFE_INTEGER : parseScanLimit(el.scanLimit.value, Number.MAX_SAFE_INTEGER),
        minDelayMs: clampInt(el.minDelayMs.value, 850, 250, 8000),
        jitterMs: clampInt(el.jitterMs.value, 250, 0, 5000),
        burstCount: clampInt(el.burstCount.value, 6, 1, 100),
        burstPauseMs: clampInt(el.burstPauseMs.value, 2200, 0, 15000),
        maxRetries: clampInt(el.maxRetries.value, 5, 0, 20),
        skipArchivedThreads: Boolean(el.skipArchivedThreads.checked),
        skipLockedThreads: Boolean(el.skipLockedThreads.checked),
        skipMissingPermissions: Boolean(el.skipMissingPermissions.checked),
        skipUnknownMessage: Boolean(el.skipUnknownMessage.checked)
      };

      state.running = true;
      state.cancelled = false;
      el.start.disabled = true;
      el.cancel.disabled = false;

      try {
        setStatus("Validating token/session...");
        const user = await fetchCurrentUser(token, opts.maxRetries, setStatus);
        const userId = user.id;
        const totals = {
          scanned: 0,
          matched: 0,
          deleted: 0,
          failed: 0,
          sinceBurst: 0,
          channelsVisited: 0,
          channelsTotal: opts.serverWide ? 0 : 1
        };

        if (opts.serverWide) {
          const canUseGuildSearch = !opts.deleteAll && (!opts.useUserId || opts.filterUserIds.length <= 1);

          if (canUseGuildSearch) {
            setStatus("Searching server for matching messages...");
            await purgeGuildSearchMessages(token, userId, opts, totals, setStatus);
          } else {
            setStatus("Loading server channels...");
            const channels = await fetchGuildChannels(token, opts.guildId, opts.maxRetries, setStatus);
            totals.channelsTotal = channels.length;

            for (const channel of channels) {
              if (state.cancelled) throw new Error("Operation cancelled.");
              if (totals.deleted >= opts.limit) break;

              totals.channelsVisited++;
              await purgeChannelMessages(
                token,
                userId,
                channel.id,
                channel.name || channel.id,
                opts,
                totals,
                setStatus
              );
            }
          }
        } else {
          await purgeChannelMessages(
            token,
            userId,
            opts.channelId,
            opts.channelId,
            opts,
            totals,
            setStatus
          );
        }

        const finalDeleted = opts.dryRun ? totals.matched : totals.deleted;
        const lines = [
          opts.dryRun ? "Dry run complete" : "Purge complete",
          `Scope: ${opts.serverWide ? "Current server" : "Current channel"}`,
          `Scanned: ${totals.scanned}`,
          `Matched: ${totals.matched}`,
          `${opts.dryRun ? "Would delete" : "Deleted"}: ${finalDeleted}`,
          `Failed: ${totals.failed}`
        ];
        if (opts.serverWide) {
          lines.push(`Channels visited: ${totals.channelsVisited}/${totals.channelsTotal}`);
        }
        if (!opts.deleteAll) {
          lines.push(`Hit target: ${finalDeleted >= opts.limit ? "yes" : "no"}`);
        }
        setStatus(lines.join("\n"));
      } catch (error) {
        setStatus(`Stopped: ${String(error?.message ?? error)}`);
      } finally {
        state.running = false;
        state.cancelled = false;
        el.start.disabled = false;
        el.cancel.disabled = true;
      }
    });
  }

  function injectToggleButton(panel) {
    const INJECT_ID = "dsmd-toggle-btn";

    function tryInject() {
      if (document.getElementById(INJECT_ID)) return;
      // Find the toolbar containing Discord's Search button.
      let toolbar = null;
      const searchBtn = document.querySelector('[aria-label="Search"]');
      if (searchBtn) toolbar = searchBtn.closest('[class*="toolbar"]');
      if (!toolbar) toolbar = document.querySelector('[class*="toolbar-"]');
      if (!toolbar) return;

      const btn = document.createElement("button");
      btn.id = INJECT_ID;
      btn.title = "Toggle Safe Mass Delete";
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:block"><path d="M9 3h6l1 2H8L9 3zm-4 3h14l-.8 3H4.8L5 6zm1.2 4l.9 10h9.8l.9-10H6.2zm3.3 2h1.1l.4 6h-1.1l-.4-6zm3.2 0h1.1l-.4 6h-1.1l.4-6z"/></svg>`;
      btn.addEventListener("click", () => {
        const visible = panel.style.display !== "none";
        panel.style.display = visible ? "none" : "block";
        btn.classList.toggle("dsmd-active", !visible);
        if (!visible) {
          // Re-detect channel when opening.
          const id = detectChannelIdFromUrl();
          const input = panel.querySelector("#dsmd-channelId");
          if (id && input && !input.value) input.value = id;
        }
      });
      toolbar.prepend(btn);
    }

    tryInject();
    new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
  }

  function applyTheme(panel) {
    const dark =
      document.documentElement.classList.contains("theme-dark") ||
      document.body.classList.contains("theme-dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    panel.classList.toggle("dsmd-dark", dark);
  }

  if (document.getElementById("dsmd-panel")) return;
  const panel = createUi();
  panel.style.display = "none";
  bindUi(panel);
  applyTheme(panel);
  new MutationObserver(() => applyTheme(panel)).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => applyTheme(panel)).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  injectToggleButton(panel);
})();