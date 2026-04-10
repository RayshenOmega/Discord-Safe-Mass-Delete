# Discord Safe Mass Delete (Greasemonkey Userscript)

This repository contains a Greasemonkey userscript that adds an in-page moderation and cleanup panel to Discord in the browser.

Author:

1. Rayshen
2. GitHub: https://github.com/RayshenOmega

Primary file:

- discord-safe-mass-delete.user.js

## Important Warning

Using selfbot-style automation, scripted deletion tools, or direct token-based API actions on Discord can violate Discord's Terms of Service and/or platform rules.

Use of this script may put the account at risk of action by Discord, including restrictions or bans.

If you choose to use it, you do so at your own risk.

## What the Script Does

The userscript injects a trashcan button into Discord's top toolbar near the Search control. Clicking that button opens a floating control panel that lets you scan for and delete messages with configurable filters and safety pacing.

Core capabilities:

1. Deletes messages in the current channel.
2. Deletes your messages across the current server.
3. Supports delete-all mode for the current channel.
4. Supports filtering by specific user ID.
5. Supports filtering by date range.
6. Supports dry-run mode before real deletion.
7. Uses rate-limit-aware pacing and retries.
8. Supports skipping selected non-fatal Discord API errors.
9. Works with Discord's dark theme.
10. Can be shown or hidden from a trashcan icon in the Discord toolbar.

## Interface Overview

When the userscript is active, it adds:

1. A trashcan toggle button near Discord's Search UI.
2. A floating panel with token, channel, filter, and safety controls.
3. Live status output showing scan progress, matched messages, deleted messages, and failures.

## Main Modes

### Current Channel Mode

This is the default mode.

The script scans the selected channel and processes messages according to your selected filters.

Typical uses:

1. Delete your own messages in one channel.
2. Delete all messages in one channel if you have permission.
3. Delete messages from one or more specific user IDs in one channel.

### Server-Wide Own Messages Mode

When `Delete my messages across current server` is enabled, the script targets your messages across the current guild.

Behavior:

1. Requires you to be inside a server channel, not a DM.
2. Ignores the manually entered channel ID.
3. Uses Discord's guild search API when possible to find your messages directly.
4. Falls back to channel-by-channel scanning for combinations that guild search cannot handle cleanly.

Typical uses:

1. Remove your own message history across a server.
2. Dry-run a server-wide scan before deletion.

## Filters and Controls

### Discord Token

The script sends authenticated Discord API requests using the token you provide in the panel.

If the token is invalid, expired, malformed, or not valid for the active account/session, requests will fail with authorization errors.

### Channel ID

This is used in current-channel mode.

You can:

1. Paste a channel ID manually.
2. Use `Detect Channel From URL` to pull it from the current Discord page.

### Delete Limit

Sets the maximum number of matched messages to delete in the current run.

If `Delete ALL messages in channel` is enabled, the limit field is disabled and the script continues until no more matching messages are found or the operation is cancelled.

### Delete ALL Messages In Channel

This affects current-channel mode.

Behavior:

1. Removes the normal delete limit.
2. Processes all matching messages in the current channel.
3. If no user filter is active, it can target all messages in the channel.

### Delete My Messages Across Current Server

This enables server-wide mode.

Behavior:

1. Scans your messages across the current guild.
2. Does not require a channel ID.
3. Uses server/guild context from the current URL.

### Date Range Filter

Enable `Filter by date range` to reveal:

1. `From`
2. `To`

Behavior:

1. Only messages inside the selected time window are matched.
2. `From` older than `To` is required.
3. The script uses Discord snowflake cursors and timestamp checks to reduce unnecessary scanning.

### User ID Filter

Enable `Filter by user ID(s)` to reveal a text field.

Accepted input:

1. One user ID
2. Multiple IDs separated by spaces
3. Multiple IDs separated by commas

Behavior:

1. In current-channel mode, only messages by the listed users are matched.
2. In server-wide mode, single-user filters can use guild search directly.
3. Multiple-user server-wide cases may fall back to slower channel scanning.

### Dry Run Only

When enabled, the script scans and counts messages but does not send delete requests.

This is the safest way to verify:

1. filters are correct
2. date ranges are correct
3. server-wide targeting is working
4. expected message volume is reasonable

### Confirm Token

For real deletion, you must type:

1. `DELETE`

This is a safety confirmation to prevent accidental execution.

## Advanced Safety Controls

### Scan Limit

Controls how many messages can be scanned in non-unbounded modes.

Higher values improve coverage but increase request volume and runtime.

### Min Delay ms

Base delay added before each delete request.

Higher values reduce request pressure.

### Jitter ms

Adds random extra delay per request.

This prevents perfectly uniform timing.

### Burst Count

Number of deletes before a larger cooldown pause is applied.

### Burst Pause ms

Additional pause inserted after each burst.

### Max Retries

Maximum retry attempts for:

1. HTTP 429 rate limits
2. transient 5xx errors
3. network failures

## Skip Error Toggles

Under Advanced safety controls, the script exposes toggleable non-fatal error skipping.

### Skip Archived Threads

Skips Discord error code `50083`.

Use this when archived thread messages should not stop the run.

### Skip Locked Threads

Skips Discord error code `160005`.

Use this when locked thread messages should be ignored instead of terminating the job.

### Skip Missing Permissions

Skips HTTP `403` delete failures.

Use this when you expect some channels or messages to be undeletable due to permission restrictions.

### Skip Unknown Messages

Skips HTTP `404` responses.

This is useful when a message disappears between scan and delete.

## Rate-Limit Handling

The script is designed to pace delete traffic rather than firing requests as fast as possible.

It currently includes:

1. configurable per-request base delay
2. random jitter
3. burst pause cooldowns
4. automatic 429 `retry_after` waiting
5. bounded retry behavior for temporary failures

This reduces API pressure, but it does not make the activity safe from detection or policy enforcement.

## Installation

### Greasemonkey Setup

1. Install Firefox.
2. Install Greasemonkey.
3. Create a new userscript.
4. Replace the generated content with the contents of `discord-safe-mass-delete.user.js`.
5. Save the script.
6. Open Discord in Firefox at `https://discord.com/channels/...`.

## Typical Usage

### Current Channel Cleanup

1. Open the target channel in Discord.
2. Click the trashcan icon near Search.
3. Paste your token.
4. Confirm or detect the channel ID.
5. Set filters.
6. Enable `Dry run only` first.
7. Review the result.
8. Disable dry run.
9. Type `DELETE`.
10. Start the run.

### Server-Wide Own Message Cleanup

1. Open any text channel in the target server.
2. Open the panel.
3. Paste your token.
4. Enable `Delete my messages across current server`.
5. Optionally set date range filters.
6. Run a dry run first.
7. If the results are correct, disable dry run and confirm with `DELETE`.

## Status Output

The panel reports live progress, including values such as:

1. current scope
2. current channel when applicable
3. scanned count
4. matched count
5. deleted count
6. failed count
7. channel progress in server-wide channel-scan mode

## Known Limitations

1. Server-wide behavior depends in part on Discord search/index availability.
2. Some channel types, permissions, archived threads, and locked threads may prevent deletion.
3. Large runs can take a long time because the script deliberately spaces requests.
4. Multiple-user server-wide filters are less efficient than single-user search cases.
5. The script depends on Discord's web app structure and API behavior, which may change.

## Operational Risks

1. Direct token-based automation is risky.
2. Excessive deletion activity may trigger rate limits or account review.
3. Even with delays and retries, the script may still be detectable as automated behavior.
4. Deleting messages from users other than yourself may require moderator permissions and can fail with `403`.

## Recommendation

If you use this at all:

1. test with dry run first
2. keep limits conservative
3. keep delays conservative
4. avoid unnecessary repeated runs
5. assume the account could be at risk under Discord policy
