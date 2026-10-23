// Metric dictionary: every tile's info button shows its definition, source and caveat.

export interface MetricDefinition {
  label: string;
  definition: string;
  source: string;
  caveat?: string;
}

export const METRICS = {
  sessions: {
    label: 'Sessions',
    definition: 'App sessions started in the period.',
    source: 'session_started events',
    caveat: 'Counts events, not guests. A guest who opens the app three times counts three times.',
  },
  appOpens: {
    label: 'App opens',
    definition: 'Times the app was opened or brought to the foreground.',
    source: 'app_opened events',
  },
  loginRate: {
    label: 'Login success',
    definition: 'Successful logins divided by login attempts.',
    source: 'login_completed ÷ login_initiated',
    caveat: 'Retries count as extra attempts. Hidden below 20 attempts.',
  },
  playersLoggedIn: {
    label: 'Accounts logged in',
    definition: 'Distinct accounts with at least one successful login.',
    source: 'login_completed, by account (userId)',
    caveat: 'By account, not player card: one account can carry several player IDs.',
  },
  activeGuests: {
    label: 'Active accounts',
    definition: 'Distinct accounts with any app event.',
    source: 'All events, by account (userId)',
  },
  onsiteShare: {
    label: 'On-property share',
    definition: 'Share of events sent while the device was on property.',
    source: 'locationContext = onsite',
    caveat: 'Events, not guests. Events without location count as off-property context.',
  },
  apiErrors: {
    label: 'API errors',
    definition: 'Failed API calls the app reported.',
    source: 'api_error events',
    caveat: 'Counts calls, not guests; one guest retrying adds several errors. Failed analytics uploads lose events, so all counts are floors.',
  },
  totalEvents: {
    label: 'Total events',
    definition: 'All analytics events received.',
    source: 'All events',
  },
  inboxViewed: { label: 'Inbox views', definition: 'Times guests opened the message inbox.', source: 'notification_list_viewed' },
  opened: { label: 'Messages opened', definition: 'Messages opened from the inbox.', source: 'notification_details_viewed' },
  markedRead: { label: 'Marked read', definition: 'Messages marked as read.', source: 'notification_marked_read' },
  ctaCompleted: {
    label: 'CTA completed',
    definition: 'Opened messages whose call to action was completed.',
    source: 'notification_details_viewed with is_cta_completed = true',
    caveat: 'Has never been true in this data: likely a tracking gap rather than zero engagement.',
  },
  deleted: { label: 'Deleted', definition: 'Messages deleted from the inbox.', source: 'notification_deleted' },
  pushOpened: {
    label: 'Push opens',
    definition: 'Push notifications the guest tapped.',
    source: 'push_opened',
  },
  pushReceived: {
    label: 'Push received (foreground)',
    definition: 'Pushes the app handled while open.',
    source: 'push_device_handled',
    caveat: 'A floor: pushes delivered while the app was closed are not counted.',
  },
  permissionGranted: {
    label: 'Permission granted',
    definition: 'Notification permission granted events.',
    source: 'notification_permission_granted',
    caveat: 'Fires on every app launch, so it is not an opt-in count. Never compute an opt-in rate from it.',
  },
  permissionDenied: { label: 'Permission denied', definition: 'Notification permission denials.', source: 'notification_permission_denied' },
  serverErrors: {
    label: 'Server errors (5xx)',
    definition: 'API errors with an HTTP 5xx status.',
    source: 'api_error, status_code 500–599',
    caveat: 'Counts calls, not guests.',
  },
  uploadFailures: {
    label: 'Analytics upload failures',
    definition: 'Errors on the endpoint that uploads these analytics events.',
    source: 'api_error on account/analyticLogs',
    caveat: 'Each failure loses a batch of events, so every other metric undercounts.',
  },
  biometricRate: {
    label: 'Biometric pass rate',
    definition: 'Face ID / Touch ID checks that passed.',
    source: 'biometric_validation_completed ÷ (completed + failed)',
    caveat: 'Hidden below 20 checks.',
  },
  dau: {
    label: 'DAU',
    definition: 'Daily active accounts, averaged over the days in the period.',
    source: 'Accounts with a foreground event that day',
    caveat: `Active = at least one foreground event (opening the app, screens, taps, features). Geofence triggers, push receipts, backgrounding, permission checks and API errors don't count. Counts accounts, not devices: logged-out use is not counted separately.`,
  },
  wau: {
    label: 'WAU',
    definition: 'Weekly active accounts: distinct accounts active in the trailing 7 days, averaged over the period.',
    source: 'Accounts with a foreground event in the 7 days ending each day',
  },
  mau: {
    label: 'MAU',
    definition: 'Monthly active accounts: distinct accounts active in the 30 days ending on the last day of the period.',
    source: 'Accounts with a foreground event in the trailing 30 days',
  },
  dauMau: {
    label: 'DAU/MAU',
    definition: 'Stickiness: the share of monthly active accounts that are active on a given day, averaged over the period.',
    source: 'Daily DAU ÷ trailing-30-day MAU',
    caveat: 'Casino guests visit weekly or monthly, so WAU/MAU is usually the more telling ratio.',
  },
  wauMau: {
    label: 'WAU/MAU',
    definition: 'The share of monthly active accounts that are active in a given week, averaged over the period.',
    source: 'Trailing-7-day WAU ÷ trailing-30-day MAU',
  },
  periodActive: {
    label: 'Active accounts',
    definition: 'Distinct accounts with at least one foreground event in the period.',
    source: 'Foreground events, by account (userId)',
  },
  newAccounts: {
    label: 'New accounts',
    definition: 'Active accounts whose first foreground event ever falls in the period.',
    source: 'First active day per account',
    caveat: '"Ever" means since the oldest data kept (13 months in production); older accounts can look new after that.',
  },
  returningAccounts: {
    label: 'Returning accounts',
    definition: 'Active accounts that were first active before the period.',
    source: 'Active accounts − new accounts',
  },
  onsiteAccounts: {
    label: 'Active on property',
    definition: 'Accounts with at least one foreground event sent while on property.',
    source: 'Foreground events with locationContext = onsite',
    caveat: 'Geofence entries alone don\'t count: the guest has to use the app on property.',
  },
  returned7: {
    label: 'Came back within 7 days',
    definition: 'New accounts in the period that were active again in the 7 days after their first day.',
    source: 'First active day + 1 to + 7',
    caveat: 'Only accounts whose 7 days have fully passed count. Hidden below 20 accounts.',
  },
  returned30: {
    label: 'Came back within 30 days',
    definition: 'New accounts in the period that were active again in the 30 days after their first day.',
    source: 'First active day + 1 to + 30',
    caveat: 'Only accounts whose 30 days have fully passed count. Hidden below 20 accounts.',
  },
  pushFailRate: {
    label: 'Send failure rate',
    definition: 'Share of messages the platform tried to send (push, email, SMS, real-time) that failed.',
    source: 'Platform send log (dextrans dexcomm.apnLogs)',
    caveat: 'Counts send attempts, not guests. Failure reasons have tokens and card numbers removed.',
  },
  stuckJobs: {
    label: 'Stuck job runs',
    definition: 'Scheduled job runs that started over an hour ago and never finished.',
    source: 'Scheduled job log (dextrans dexcron.jobStatus)',
  },

  // Chickasaw CDP. "12 months" ends on the CDP's as-of date.
  cdpPlayers: {
    label: 'Players',
    definition: 'Club Passport accounts in the patron master.',
    source: 'cdp.player_profile (WinStar patron master)',
    caveat: 'Dev holds a sample of the enterprise list.',
  },
  cdpActive: {
    label: 'Active in 12 months',
    definition: 'Players with a gaming trip or a completed hotel, dining, retail, spa or golf record at any site in the 12 months.',
    source: 'cdp.player_site_summary',
    caveat: 'Gaming outside WinStar and all non-gaming are mock data.',
  },
  cdpMarketable: {
    label: 'Marketable',
    definition: 'Players we may contact on at least one channel: a contact on file, a current opt-in, and not self-excluded.',
    source: 'cdp.reachability',
    caveat: 'Opt-ins are mock: Chickasaw keeps none yet.',
  },
  cdpMultiSite: {
    label: 'Multi-site players',
    definition: 'Players active at two or more sites in the 12 months.',
    source: 'cdp.player_profile.sites_visited_12m',
    caveat: 'Play outside WinStar is mock data.',
  },
  cdpAppLinked: {
    label: 'App linked',
    definition: 'Players whose Chickasaw app account is linked to their Club Passport number.',
    source: 'cdp.identity_link (app_user)',
    caveat: 'App users and events are mock data.',
  },
  cdpExcluded: {
    label: 'Self-excluded',
    definition: 'Players with an entry in the exclusion history. Never reachable and never in a segment.',
    source: 'dexiga.exclusion_history (real)',
    caveat: 'Exclusions have no expiry logic yet.',
  },
  cdpTheo: {
    label: 'Theo, 12 months',
    definition: 'Theoretical win from rated play at every site.',
    source: 'cdp.gaming_activity',
  },
  cdpAdt: {
    label: 'ADT',
    definition: 'Average daily theo: theo divided by gaming days.',
    source: 'cdp.player_profile.adt_12m',
  },
  cdpVisitDays: {
    label: 'Visit days',
    definition: 'Days with a gaming trip or completed non-gaming activity, counted per site and added up.',
    source: 'cdp.player_site_summary',
  },
  cdpNonGaming: {
    label: 'Non-gaming paid',
    definition: 'Hotel, dining, retail, spa and golf paid for, before tax and tips. Comps and points are left out.',
    source: 'cdp.non_gaming_activity',
    caveat: 'All non-gaming is mock data until the Agilysys feeds arrive.',
  },
  cdpCombined: {
    label: 'Combined value',
    definition: 'Theo plus non-gaming paid over the 12 months. Drives the value (M) score.',
    source: 'cdp.player_profile.combined_value_12m',
  },
  cdpComps: {
    label: 'Comps issued',
    definition: 'Gaming comps on trip summaries: food, beverage, room and other.',
    source: 'cdp.gaming_activity',
  },
  cdpAppDays: {
    label: 'App days, last 90',
    definition: 'Days with any app event in the last 90 days of the window.',
    source: 'cdp_mock.app_event',
    caveat: 'Mock data.',
  },
} satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRICS;
