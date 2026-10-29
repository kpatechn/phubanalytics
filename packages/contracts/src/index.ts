// Response shapes for GET /api/analytics/*. Dates are YYYY-MM-DD in the
// property's time zone; ranges are inclusive. Counts are events unless the
// name says guests or accounts.

export type Environment = 'prod' | 'staging' | 'dev';
export type View = 'executive' | 'engagement' | 'marketing' | 'it' | 'cdp' | 'reinvestment';
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

export interface CdpPlayerHost {
  siteCode: string;
  repCode: number;
  /** Staff name from the loyalty system's rep master; null when the rep isn't listed. */
  name: string | null;
  permanent: boolean;
  nextArrival: string | null;
}

/** Loyalty account figures from the WinStar loyalty system. Tier and points are shared across sites. */
export interface CdpLoyalty {
  memberSince: string | null;
  lastActivity: string | null;
  lifetimeTrips: number | null;
  /** Positive = the player lost. */
  lifetimeCasinoWin: number | null;
  lifetimeComps: number | null;
  actionCashEarned: number | null;
  actionCashUsed: number | null;
  /** Tier points counting toward status, and when the current status expires. */
  tierPoints: number | null;
  tierExpires: string | null;
  /** Points the current tier needs (0 for the base tier). */
  keepTierPoints: number | null;
  nextTier: string | null;
  nextTierPoints: number | null;
  pointsToNextTier: number | null;
  points: { lifetime: number | null; year: number | null; yearLabel: string | null };
  /** Reward dollars. No balance: the sample can't support one. */
  rewards: {
    earnedLifetime: number | null;
    redeemedLifetime: number | null;
    adjustedLifetime: number | null;
    expiredLifetime: number | null;
    earnedYear: number | null;
    redeemedYear: number | null;
  };
}

export interface CdpPreferences {
  /** Loyalty system game code (game names aren't loaded yet). */
  topGame: string | null;
  topGameShare: number | null;
  topDenomination: number | null;
  topDenominationShare: number | null;
  slotRatings: number;
  /** ISO weekday, 1 Monday .. 7 Sunday. */
  favoriteWeekday: number | null;
  weekdayShare: number | null;
  favoriteDaypart: 'morning' | 'afternoon' | 'evening' | 'late night' | null;
  daypartShare: number | null;
}

export interface CdpPlayer {
  accountNumber: string;
  profile: CdpPlayerProfile;
  hosts: CdpPlayerHost[];
  /** Null when the WinStar loyalty sample has no lifetime or points row for the player. */
  loyalty: CdpLoyalty | null;
  /** Null when the player has no rated play or trips in the 12 months. */
  preferences: CdpPreferences | null;
  sites: CdpPlayerSite[];
  /** Latest 30 activities: gaming trips and non-gaming records. */
  recent: CdpActivity[];
  reach: CdpPlayerReach[];
  segments: { code: string; name: string }[];
  /** Which identifiers point to this account. Values are never sent. */
  identifiers: { type: 'email' | 'mobile' | 'app_user'; verified: boolean }[];
}

// ---- Reinvestment: the data platform's serving database (one tenant, set in the API's config).
// Money is US dollars; dates YYYY-MM-DD; patron IDs are the platform's pseudonymous IDs (no names).

export interface RxMeta {
  tenant: string;
  /** 'mock' for simulated tenants: every page says the data is fictional. */
  dataKind: 'mock' | 'real';
  asOfMonth: string | null;
  /** Finance rule version behind every contribution, e.g. 'draft-1:draft'. */
  ruleVersion: string | null;
  sites: { siteId: string; name: string }[];
  optimizerEnabled: boolean;
}

export interface RxEnvelope<T> {
  meta: RxMeta;
  data: T;
}

export interface RxSiteMonth {
  siteId: string;
  siteName: string;
  month: string;
  patrons: number;
  visits: number;
  theo: number;
  casinoWin: number;
  freeplayRedeemed: number;
  compsIssued: number;
  reinvestment: number;
  incentiveCost: number;
  hospitalityPaid: number;
  netContribution: number;
}

export type RxVerdict = 'window open' | 'too small to read' | 'pays back' | 'loses money' | 'no clear effect';

export interface RxCampaign {
  campaignId: string;
  name: string;
  offerType: string;
  faceValue: number | null;
  channelRule: string;
  audienceName: string | null;
  audienceRule: string;
  holdoutShare: number;
  assignedDate: string;
  windowEnd: string;
  nTreatment: number | null;
  nHoldout: number | null;
  excludedPatrons: number;
  sentRate: number | null;
  deliveredRate: number | null;
  openedRate: number | null;
  redeemedRate: number | null;
  visitsLift: number | null;
  visitsCiLow: number | null;
  visitsCiHigh: number | null;
  theoLift: number | null;
  theoCiLow: number | null;
  theoCiHigh: number | null;
  netLift: number | null;
  netCiLow: number | null;
  netCiHigh: number | null;
  netSignificant: boolean | null;
  netIncrementalProfit: number | null;
  servicingCost: number | null;
  underpowered: boolean | null;
  imbalanced: boolean | null;
  heavyOverlap: boolean | null;
  windowClosed: boolean | null;
  verdict: RxVerdict;
}

export interface RxOverview {
  months: RxSiteMonth[];
  campaigns: RxCampaign[];
}

export type RxMetric = 'visits' | 'theo' | 'net_contribution' | 'incentive_cost';

export interface RxLift {
  segment: string;
  metric: RxMetric;
  nTreatment: number;
  nHoldout: number;
  meanTreatment: number;
  meanHoldout: number;
  adjustedDiff: number;
  adjustedCiLow: number;
  adjustedCiHigh: number;
  significant: boolean;
  minDetectableEffect: number;
  prePeriodSmd: number | null;
  underpowered: boolean;
}

export interface RxCampaignDetail {
  campaign: RxCampaign;
  lift: RxLift[];
}

export interface RxPatronExample {
  patronId: string;
  tierName: string | null;
  homePropertyId: string | null;
  netContribution12m: number;
  note: string;
}

export interface RxEvent {
  eventAt: string;
  eventType: string;
  siteId: string | null;
  campaignId: string | null;
  channel: string | null;
  amount: number | null;
  detail: string | null;
}

export interface RxPatron {
  patronId: string;
  asOfDate: string;
  tierName: string | null;
  tierPoints: number | null;
  nextTierName: string | null;
  pointsToNextTier: number | null;
  homePropertyId: string | null;
  sitesVisited12m: number;
  visits12m: number;
  theo12m: number;
  adt12m: number | null;
  casinoWin12m: number;
  reinvestment12m: number;
  reinvestmentRate: number | null;
  hospitalityPaid12m: number;
  netContribution12m: number;
  recencyDays: number | null;
  suppressOffers: boolean;
  reach: { channel: string; reason: string }[];
  journey: RxEvent[];
}

export interface RxConstraint {
  kind: 'budget' | 'max_offers' | 'site_cap' | 'site_floor' | 'patrons' | 'room_nights';
  name: string;
  unit: string;
  limit: number;
  used: number | null;
  binding: boolean | null;
  /** Profit from one more unit of this limit. */
  shadowPrice: number | null;
}

export interface RxAllocation {
  templateId: string;
  segment: string;
  siteId: string;
  eligible: number;
  offers: number;
  valuePerOffer: number;
  costPerOffer: number;
  spend: number;
  profit: number;
  responseSource: string;
  reason: string;
}

export interface RxRunParams {
  budget: number;
  holdout: number;
  risk: 'conservative' | 'expected';
  caps: Record<string, number>;
  floors: Record<string, number>;
  maxOffers: number | null;
}

export interface RxRun {
  runId: string;
  createdAt: string;
  status: string;
  requestedBy: string | null;
  params: RxRunParams;
  spend: number;
  profit: number;
  offers: number;
  holdoutPatrons: number;
  baseline: { spend: number; profit: number; offers: number };
  constraints: RxConstraint[];
  skipped: { templateId: string; segment?: string; siteId?: string; eligible?: number; reason: string }[];
}

export interface RxRunDetail {
  run: RxRun;
  allocation: RxAllocation[];
}

export type RxRunRequest = Partial<Omit<RxRunParams, 'budget'>> & { budget: number };
