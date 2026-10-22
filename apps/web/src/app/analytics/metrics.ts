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
} satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRICS;
