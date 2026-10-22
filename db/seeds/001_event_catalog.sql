-- Event catalog and dimension rules. Same for every property and environment.
-- Display names follow the plan's names (from the portal export). Features follow
-- the plan's feature map; rows marked "added" are events the plan did not list.

BEGIN;

INSERT INTO analytics."eventCatalog" ("eventId", "displayName", category, feature) VALUES
    -- Session
    ('session_started',                   'Session started',                    'session',    NULL),
    ('session_ended',                     'Session ended',                      'session',    NULL),
    ('app_opened',                        'App opened',                         'session',    NULL),
    ('app_backgrounded',                  'App backgrounded',                   'session',    NULL),
    -- Authentication
    ('login_initiated',                   'Login process started',              'auth',       NULL),
    ('login_completed',                   'Login success',                      'auth',       NULL),
    ('logout_completed',                  'User logged out',                    'auth',       NULL),
    ('biometric_validation_completed',    'FaceID/TouchID passed',              'auth',       NULL),
    ('biometric_validation_failed',       'FaceID/TouchID failed',              'auth',       NULL),
    ('pin_validation_completed',          'PIN passed',                         'auth',       NULL),
    ('pin_validation_failed',             'PIN failed',                         'auth',       NULL),
    -- Navigation
    ('page_open',                         'Page opened',                        'navigation', NULL),
    ('button_clicked',                    'Generic button tap',                 'navigation', NULL),
    ('pull_to_refresh',                   'Pull to refresh',                    'navigation', NULL),
    ('webview_viewed',                    'Web content viewed',                 'navigation', NULL),
    -- Features
    ('wallet_screen_viewed',              'Cashless Wallet screen opened',      'feature',    'Wallet'),
    ('wallet_balance_checked',            'Wallet balance refreshed',           'feature',    'Wallet'),
    ('fast_funds_viewed',                 'Fast Funds screen opened',           'feature',    'Fast Funds'),
    ('notification_list_viewed',          'Inbox list viewed',                  'feature',    'Inbox'),
    ('live_drawing_viewed',               'Live drawing screen opened',         'feature',    'Live Drawing'),
    ('promotions_screen_viewed',          'Promotions screen viewed',           'feature',    'Promotions'),
    ('promotion_details_viewed',          'Promotion details viewed',           'feature',    'Promotions'),
    ('offer_list_viewed',                 'Offers list rendered',               'feature',    'Promotions'),
    ('event_list_viewed',                 'Events list page opened',            'feature',    'Events'),
    ('event_details_viewed',              'Event details page opened',          'feature',    'Events'),
    ('gaming_hub_screen_viewed',          'Gaming hub screen viewed',           'feature',    'Gaming'),
    ('table_games_screen_viewed',         'Table games main screen viewed',     'feature',    'Gaming'),
    ('slots_screen_viewed',               'Slots screen viewed',                'feature',    'Gaming'),
    ('live_poker_screen_viewed',          'Live poker screen viewed',           'feature',    'Gaming'),
    ('high_limit_screen_viewed',          'High limit screen viewed',           'feature',    'Gaming'),          -- added
    ('restaurant_list_viewed',            'Restaurants list viewed',            'feature',    'Dining & Resort'),
    ('resort_info_viewed',                'Property Info screen viewed',        'feature',    'Dining & Resort'),
    ('pool_screen_viewed',                'Resort pool screen viewed',          'feature',    'Dining & Resort'),
    ('link_account_clicked',              'Link flow started',                  'feature',    'Card linking'),
    ('link_account_completed',            'Link flow completed',                'feature',    'Card linking'),    -- added
    ('tier_status_viewed',                'Tier status viewed',                 'feature',    'Tier status'),
    ('winloss_statement_requested',       'Win/loss tax report sent',           'feature',    'Tax report'),
    ('gift_and_go_claim_clicked',         'Gift & Go claim tapped',             'feature',    'Gift & Go'),       -- added
    ('gift_and_go_redeem_initiated',      'Gift & Go redeem started',           'feature',    'Gift & Go'),       -- added
    ('gift_and_go_redeem_success',        'Gift & Go redeem succeeded',         'feature',    'Gift & Go'),       -- added
    -- Messaging
    ('notification_details_viewed',       'Notification detail opened',         'messaging',  NULL),
    ('notification_marked_read',          'Notification marked read',           'messaging',  NULL),
    ('notification_deleted',              'Notification deleted',               'messaging',  NULL),
    ('push_opened',                       'Player opened push notification',    'messaging',  NULL),
    ('push_device_handled',               'Push received (device handling)',    'messaging',  NULL),
    ('push_cta_clicked',                  'Push CTA tapped',                    'messaging',  NULL),
    -- Permissions
    ('notification_permission_granted',   'Notification permission granted',    'permission', NULL),
    ('notification_permission_denied',    'Notification permission denied',     'permission', NULL),
    ('notification_permission_changed',   'Notification permission changed',    'permission', NULL),
    ('location_permission_granted',       'Location permission granted',        'permission', NULL),
    ('location_permission_denied',        'Location permission denied',         'permission', NULL),
    ('location_permission_always_denied', 'Location permission always denied',  'permission', NULL),
    ('bluetooth_permission_granted',      'Bluetooth permission granted',       'permission', NULL),
    ('permission_opted_out',              'Permission opted out',               'permission', NULL),
    -- Location
    ('geofence_entered',                  'Geofence entered',                   'location',   NULL),
    ('geofence_exited',                   'Geofence exited',                    'location',   NULL),
    -- Errors
    ('api_error',                         'API error',                          'error',      NULL);

INSERT INTO analytics."dimensionRule" ("eventId", "dimensionType", "sourceKey", "numericKey") VALUES
    ('page_open',                      'screen',         'screen_name',       NULL),
    ('button_clicked',                 'button',         '@mobileName',       NULL),
    ('pull_to_refresh',                'page',           'page',              NULL),
    ('webview_viewed',                 'web_page',       'title',             'time_spent_ms'),
    ('promotion_details_viewed',       'promotion',      '@mobileName',       'time_spent_ms'),
    ('event_details_viewed',           'event',          '@mobileName',       'time_spent_ms'),
    ('live_drawing_viewed',            'drawing',        '@mobileName',       NULL),
    ('tier_status_viewed',             'tier',           'tier_status',       NULL),
    ('notification_details_viewed',    'message_title',  'title',             NULL),
    ('notification_details_viewed',    'cta_completed',  'is_cta_completed',  NULL),
    ('notification_marked_read',       'message_title',  'title',             NULL),
    ('push_opened',                    'campaign',       'campaign_id',       NULL),
    ('push_opened',                    'platform',       'platform',          NULL),
    ('push_opened',                    'device_state',   'device_state',      NULL),
    ('push_device_handled',            'provider',       'provider',          NULL),
    ('notification_permission_denied', 'denial_type',    'denial_type',       NULL),
    ('login_initiated',                'login_method',   'login_method',      NULL),
    ('login_completed',                'auth_method',    'auth_method',       NULL),
    ('logout_completed',               'account_delete', 'is_account_delete', NULL),
    ('biometric_validation_completed', 'biometric_type', 'biometric_type',    NULL),
    ('biometric_validation_failed',    'biometric_type', 'biometric_type',    NULL),
    ('biometric_validation_failed',    'failure_reason', 'failure_reason',    NULL),
    ('geofence_entered',               'geofence',       'geofence_id',       NULL),
    ('geofence_exited',                'geofence',       'geofence_id',       NULL);

COMMIT;
