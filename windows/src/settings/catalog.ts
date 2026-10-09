// What the Settings window can configure for each integration pill: its keys,
// its plain preferences and the one line shown on its tile. Pill IDs are stable
// contract values (Keychain, settings.json, hook routing): never rename one.

export interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** One line on the Settings tile. */
  short: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** Plain (non-secret) preferences, stored in settings.json. */
  prefs?: { prop: "slackWorkspace" | "spaceTimeboxDir"; label: string; placeholder: string }[];
  /** Shows the Messages app toggles. */
  apps?: boolean;
  /** Shows the Music pill's Lyrics toggle. */
  lyrics?: boolean;
  /** One line on where the data comes from. */
  info?: string;
}

export const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE", short: "Payments",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E", short: "Pull requests",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF", short: "Deployments",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38", short: "Workflows",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E", short: "Emails",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C", short: "Pages",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A", short: "Bookings",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
  // This build's own pills: no keys, everything is read on this PC.
  { id: "integration_space", name: "Space", color: "#4F8EF7", short: "Sprint and timebox", fields: [],
    prefs: [{ prop: "spaceTimeboxDir", label: "space-timebox folder", placeholder: "%USERPROFILE%\\.claude-kantor\\mcp\\space-timebox  (empty = default)" }],
    info: "Today's sprint tasks and timebox through the local space-timebox MCP server." },
  { id: "integration_media", name: "Music", color: "#1DB954", short: "Now playing and lyrics", fields: [], lyrics: true,
    info: "Now playing from the Windows media session: Spotify, browsers, any player." },
  { id: "integration_messages", name: "Messages", color: "#5865F2", short: "Chat notifications", fields: [],
    prefs: [{ prop: "slackWorkspace", label: "Slack workspace", placeholder: "Shown on Slack messages" }],
    apps: true,
    info: "New messages read from Windows notifications. Kept in memory only." },
  { id: "integration_shelf", name: "Shelf", color: "#F5A524", short: "Screenshots and downloads", fields: [],
    info: "Files you drop on Mochi, plus your latest screenshots and downloads: drag them out, copy or open them." },
  { id: "integration_audio", name: "Audio", color: "#A78BFA", short: "Devices and the mic", fields: [],
    info: "Output and microphone: switch devices, volume, mute. Shows when an app is using the mic." },
  { id: "integration_quota", name: "Claude", color: "#E07B53", short: "5-hour and 7-day limits", fields: [],
    info: "5-hour and 7-day limits as a card. Off, sessions still show context and cost, and limit alerts still come." },
];

/** The integrations Settings offers: all but `hidden` (state.ts HIDDEN_INTEGRATIONS). */
export const visibleIntegrations = (hidden: ReadonlySet<string>): IntegrationDef[] =>
  INTEGRATIONS.filter((d) => !hidden.has(d.id));

/** Every Credential Manager key an integration can hold. */
export const INTEGRATION_KEYS = INTEGRATIONS.flatMap((d) => d.fields.map((f) => f.key));

export const APP_LABELS: Record<string, string> = {
  discord: "Discord", slack: "Slack", telegram: "Telegram", whatsapp: "WhatsApp",
};
