// Response shapes for GET /api/analytics/*. Dates are YYYY-MM-DD in the
// property's time zone; ranges are inclusive. Counts are events unless the
// name says guests or accounts.

export type Environment = 'prod' | 'staging' | 'dev';
export type View = 'executive' | 'marketing' | 'it';
export type Role = 'analytics:exec' | 'analytics:marketing' | 'analytics:it' | 'analytics:admin';

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
}

export type ExecutiveResponse = Envelope<ExecutiveData>;
export type MarketingResponse = Envelope<MarketingData>;
export type ItResponse = Envelope<ItData>;
