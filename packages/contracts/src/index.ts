// Response shapes for GET /api/analytics/*. Dates are YYYY-MM-DD in the
// property's time zone; ranges are inclusive. Counts are events unless the
// name says guests or accounts.

export type Environment = 'prod' | 'staging' | 'dev';
export type View = 'executive' | 'engagement' | 'marketing' | 'it' | 'cdp';
export type Role = 'analytics:exec' | 'analytics:marketing' | 'analytics:it' | 'analytics:cdp' | 'analytics:admin';

export interface Property {
  tenantId: number;
  propertyId: number;
  name: string;
  timeZone: string;
  environment: Environment;
}

export interface Meta {
  from: string;
  to: string;
  /** Same-length period immediately before from..to, used for deltas. */
  previousFrom: string;
  previousTo: string;
  property: Property;
  generatedAt: string;
  source: 'rollup';
  /** Newest raw event for the property (ISO timestamp). */
  dataAsOf: string | null;
  /** Last successful rollup refresh (ISO timestamp). */
  lastRefreshAt: string | null;
  /** Last successful refresh of the platform (dextrans) rollups. */
  dextransAsOf: string | null;
}

export interface Envelope<T> {
  meta: Meta;
  data: T;
}

export interface Me {
  subject: string;
  roles: Role[];
  views: View[];
  authMode: 'jwt' | 'dev';
}

/** RFC 9457 problem details. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

export interface DailyPoint {
  day: string;
  sessions: number;
  logins: number;
  errors: number;
  events: number;
}

export interface FeatureUsage {
  feature: string;
  onsite: number;
  offsite: number;
  unknown: number;
}

export interface ExecutiveKpis {
  sessions: number;
  appOpens: number;
  loginStarted: number;
  loginSuccess: number;
  /** Distinct accounts with a successful login. */
  playersLoggedIn: number;
  /** Distinct accounts with any event. */
  activeGuests: number;
  onsiteEvents: number;
  apiErrors: number;
  totalEvents: number;
}

export interface ExecutiveData {
  kpis: ExecutiveKpis;
  previous: ExecutiveKpis;
  daily: DailyPoint[];
  features: FeatureUsage[];
}

export interface MarketingData {
  funnel: {
    inboxViewed: number;
    opened: number;
    markedRead: number;
    ctaCompleted: number;
    deleted: number;
    /** Pushes the app saw in the foreground: a floor, not deliveries. */
    pushReceived: number;
    pushOpened: number;
  };
  campaigns: { campaignId: string; opens: number }[];
  topMessages: { title: string; opens: number }[];
  permissions: {
    /** Fires on app launch: not an opt-in count. */
    granted: number;
    denied: number;
    denialTypes: { type: string; count: number }[];
  };
  geofences: { geofenceId: string; zone: string; isTest: boolean; entries: number; exits: number }[];
  geofenceExits: number;
  webContent: { page: string; opens: number; avgSeconds: number | null }[];
  contentViews: { kind: 'promotion' | 'event' | 'drawing'; label: string; views: number; avgSeconds: number | null }[];
  delivery: Delivery;
  campaignResults: CampaignResult[];
}

export interface ItData {
  errors: { endpoint: string; method: string; statusCode: string; errorType: string; count: number }[];
  topMessages: { message: string; endpoint: string; statusCode: string; count: number }[];
  daily: DailyPoint[];
  hourly: { hour: number; events: number; errors: number }[];
  screens: { screen: string; opens: number }[];
  biometrics: { passed: number; failed: number };
  logins: { started: number; succeeded: number; authMethods: { method: string; count: number }[] };
  pushReceived: number;
  versions: VersionUsage[];
  sessionLength: SessionLength[];
  platforms: PlatformUsage[];
  deviceModels: DeviceModel[];
  delivery: Delivery;
  jobs: JobHealth[];
  jobDaily: { day: string; runs: number; failed: number; stuck: number }[];
}


// Platform data (database dextrans): sessions, devices, delivery, campaigns, tiers, jobs.

export interface PlatformUsage {
  platform: string;
  sessions: number;
  accounts: number;
  devices: number;
}

export interface VersionUsage {
  platform: string;
  appVersion: string;
  sessions: number;
  accounts: number;
  /** App events and API errors sent from sessions on this version. */
  events: number;
  errors: number;
  /** Highest version seen for the platform in the period. */
  isLatest: boolean;
}

export interface SessionLength {
  platform: string;
  /** Sessions with a recorded end (length known). */
  ended: number;
  sessions: number;
  avgSeconds: number | null;
  /** Bucket holding the median session. */
  medianBucket: string | null;
  buckets: { label: string; sessions: number }[];
}

export interface DeviceModel {
  platform: string;
  model: string;
  devices: number;
  accounts: number;
}

export interface DeliveryByType {
  messageType: string;
  sent: number;
  delivered: number;
  failed: number;
  /** Pending and any other status. */
  other: number;
}

export interface Delivery {
  byType: DeliveryByType[];
  /** Failure reasons with tokens, IDs and card numbers removed. */
  reasons: { reason: string; count: number }[];
  daily: { day: string; delivered: number; failed: number; other: number }[];
}

export interface CampaignResult {
  campaignId: string;
  name: string;
  category: string;
  status: string;
  targetType: string;
  isTest: boolean;
  channel: string;
  /** Messages sent in the period, and how many of those were later delivered, opened... */
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  converted: number;
  unsubscribed: number;
}

export interface JobHealth {
  jobName: string;
  isTest: boolean;
  runs: number;
  completed: number;
  failed: number;
  /** Started over an hour ago and never finished. */
  stuck: number;
  running: number;
  avgSeconds: number | null;
  maxSeconds: number | null;
  /** Latest run in the last 30 days, regardless of the period. */
  lastStartAt: string | null;
  lastStatus: string | null;
}

export interface TierUsage {
  tier: string;
  activeAccounts: number;
  onsiteAccounts: number;
  newAccounts: number;
}

/**
 * Active accounts: accounts with at least one foreground event that day
 * (eventCatalog.isForeground). Windows are trailing: WAU on a day covers that
 * day and the 6 before, MAU that day and the 29 before.
 */
export interface EngagementPoint {
  day: string;
  dau: number;
  wau: number;
  mau: number;
  /** Active accounts with a foreground event on property. */
  onsite: number;
  /** Accounts whose first active day ever is this day. */
  newAccounts: number;
  returningAccounts: number;
}

export interface EngagementSummary {
  /** Average daily active accounts over the period. */
  dau: number;
  /** Average trailing-7-day active accounts over the period. */
  wau: number;
  /** Trailing-30-day active accounts on the last day of the period. */
  mau: number;
  /** Average of the daily DAU/MAU ratio; null when MAU is 0 every day. */
  dauMau: number | null;
  wauMau: number | null;
  /** Distinct active accounts in the period. */
  activeAccounts: number;
  newAccounts: number;
  returningAccounts: number;
  /** Distinct accounts active on property at least once in the period. */
  onsiteAccounts: number;
}

/** New accounts in the period whose follow-up window has fully passed, and how many came back in it. */
export interface ReturnRate {
  days: number;
  eligible: number;
  returned: number;
}

export interface RetentionCohort {
  /** Monday of the week the accounts were first active. */
  weekStart: string;
  size: number;
  /** weeks[n]: accounts active again in week n after the cohort week (n = 0 is the cohort week). */
  weeks: { week: number; accounts: number; complete: boolean }[];
}

export interface EngagementData {
  summary: EngagementSummary;
  previous: EngagementSummary;
  daily: EngagementPoint[];
  returnRates: ReturnRate[];
  /** Accounts that used each feature in the period. */
  features: { feature: string; accounts: number }[];
  cohorts: RetentionCohort[];
  /** Events that never count as activity (eventCatalog.isForeground = false). */
  backgroundEvents: string[];
  /** First day with any history: "new" means first seen since this day. */
  historyStart: string | null;
  /** Active accounts by current loyalty tier ("(no card)" when none). */
  tiers: TierUsage[];
  /** Accounts that used each feature, by tier. */
  featureTiers: { feature: string; tier: string; accounts: number }[];
  /** Accounts, sessions and devices by platform (from server sessions). */
  platforms: PlatformUsage[];
}

export type ExecutiveResponse = Envelope<ExecutiveData>;
export type EngagementResponse = Envelope<EngagementData>;
export type MarketingResponse = Envelope<MarketingData>;
export type ItResponse = Envelope<ItData>;


// Chickasaw CDP prototype: GET /api/cdp/*, POST /api/cdp/players/lookup (database dexiga,
// schema cdp). Money in dollars; "12 months" ends meta.asOfDate. Account numbers are
// Club Passport numbers, sent as strings and never put in URLs.

export type CdpChannel = 'email' | 'sms' | 'push' | 'mail';
export type CdpReachReason = 'reachable' | 'self_excluded' | 'no_contact' | 'opted_out' | 'no_consent';
export type CdpActivityKind = 'gaming' | 'hotel' | 'dining' | 'retail' | 'spa' | 'golf';

/** One source the CDP reads. Mock feeds are generated stand-ins for data we can't reach yet. */
export interface CdpFeed {
  code: string;
  area: string;
  source: string;
  isMock: boolean;
  notes: string;
}

export interface CdpMeta {
  client: string;
  /** Last day of the 12-month window. */
  asOfDate: string;
  windowFrom: string;
  /** When cdp.refresh() last finished (ISO timestamp). */
  refreshedAt: string;
  generatedAt: string;
  feeds: CdpFeed[];
  sites: { code: string; name: string; gamingIsMock: boolean }[];
}

export interface CdpEnvelope<T> {
  meta: CdpMeta;
  data: T;
}

export interface CdpTotals {
  players: number;
  /** Any activity in the 12 months. */
  active: number;
  /** Reachable on at least one channel. */
  marketable: number;
  multiSite: number;
  selfExcluded: number;
  appLinked: number;
}

export interface CdpChannelReach {
  channel: CdpChannel;
  reachable: number;
  selfExcluded: number;
  noContact: number;
  optedOut: number;
  noConsent: number;
}

export interface CdpSegment {
  code: string;
  name: string;
  description: string;
  /** SQL condition on the player profile. */
  rule: string;
  members: number;
  /** Members reachable on each channel, and on any. */
  reach: Record<CdpChannel, number>;
  marketable: number;
  avgTheo: number;
  avgNonGamingPaid: number;
}

export interface CdpSegmentsData {
  totals: CdpTotals;
  channels: CdpChannelReach[];
  segments: CdpSegment[];
}

export interface CdpSite {
  siteCode: string;
  name: string;
  city: string;
  propertyId: string;
  /** Whether this site's gaming comes from a mock feed. */
  gamingIsMock: boolean;
  /** Players whose home site this is. */
  homePlayers: number;
  /** Players with any activity here in the 12 months. */
  activePlayers: number;
  /** Of those, players also active at another site. */
  alsoOtherSites: number;
  visitDays: number;
  trips: number;
  theo: number;
  casinoWin: number;
  compsIssued: number;
  /** Paid non-gaming in the 12 months, all guests (known or not). */
  nonGaming: Record<Exclude<CdpActivityKind, 'gaming'>, number>;
  nonGamingPaid: number;
  /** Share of nonGamingPaid from guests linked to a Club Passport number. */
  knownGuestShare: number | null;
}

export interface CdpSitesData {
  sites: CdpSite[];
  /** Players by home site who were also active at another site. */
  crossVisits: { homeSite: string; visitedSite: string; players: number }[];
}

export interface CdpExample {
  accountNumber: string;
  tierName: string;
  homeSite: string | null;
  combinedValue: number;
}

export interface CdpPlayerSite {
  siteCode: string;
  visitDays: number;
  trips: number;
  gamingDays: number;
  theo: number;
  casinoWin: number;
  compsIssued: number;
  nonGamingPaid: number;
  nonGamingComp: number;
  firstVisit: string | null;
  lastVisit: string | null;
}

export interface CdpActivity {
  date: string;
  siteCode: string;
  kind: CdpActivityKind;
  detail: string;
  /** Theo for gaming, paid amount otherwise. */
  value: number;
  comp: number;
  status: 'completed' | 'cancelled' | 'no_show';
  /** card, email (matched by a unique email) or null for gaming. */
  identityMethod: 'card' | 'email' | null;
  isMock: boolean;
}

export interface CdpPlayerReach {
  channel: CdpChannel;
  reachable: boolean;
  reason: CdpReachReason;
  hasContact: boolean;
  consentStatus: 'opt_in' | 'opt_out' | 'none';
  consentAt: string | null;
}

export interface CdpPlayerProfile {
  tierName: string;
  tierSource: 'real' | 'mock';
  residentialState: string | null;
  homeRegion: string;
  signupDate: string;
  tenureDays: number;
  isExcluded: boolean;
  homeSite: string | null;
  siteCodes: string[];
  firstActivity: string | null;
  lastActivity: string | null;
  recencyDays: number | null;
  visitDays: number;
  trips: number;
  gamingDays: number;
  theo: number;
  adt: number | null;
  casinoWin: number;
  slotTheoShare: number | null;
  compsIssued: number;
  reinvestmentRate: number | null;
  hotelStays: number;
  hotelNights: number;
  nonGaming: Record<Exclude<CdpActivityKind, 'gaming'>, number>;
  nonGamingPaid: number;
  nonGamingComp: number;
  nonGamingShare: number | null;
  combinedValue: number;
  /** 1-5 each among players active in the 12 months; null when inactive. */
  rfm: { recency: number; frequency: number; monetary: number } | null;
  app: { linked: boolean; linkedAt: string | null; activeDays90: number; lastActiveAt: string | null };
  reachableChannels: CdpChannel[];
  hasMockData: boolean;
}

export interface CdpPlayer {
  accountNumber: string;
  profile: CdpPlayerProfile;
  sites: CdpPlayerSite[];
  /** Latest 30 activities: gaming trips and non-gaming records. */
  recent: CdpActivity[];
  reach: CdpPlayerReach[];
  segments: { code: string; name: string }[];
  /** Which identifiers point to this account. Values are never sent. */
  identifiers: { type: 'email' | 'mobile' | 'app_user'; verified: boolean }[];
}
