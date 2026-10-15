Provider API fixtures for the "Import from another provider" tests
(test/provider-import-e2e.test.ts), shaped from each provider's official spec:

- beehiiv: OpenAPI 3.1 at https://developers.beehiiv.com/openapi/api-reference.json
  (PublicationsListResponse, SubscriptionsListResponse, Subscription,
  SubscriptionExpandedStatus, CustomField, Error). Cursor pagination
  (has_more / next_cursor).
- Kit: OpenAPI 3.0 at https://developers.kit.com/api-reference/v4.json
  (GET /v4/account, GET /v4/subscribers: subscribers[].state enum,
  pagination.has_next_page / end_cursor, 401 example body).
- Mailchimp: Marketing API spec, github.com/mailchimp/mailchimp-client-lib-codegen
  spec/marketing.json (GET /lists, GET /lists/{list_id}/members: members[].status
  enum, merge_fields, total_items; offset/count pagination; problem-detail errors).
- MailerLite: https://developers.mailerlite.com/api/subscribers.md and
  /getting-started.md (data[], meta.next_cursor, filter[status], limit=0 count,
  429 with Retry-After).

CSV export fixtures (csv/) follow the real export header rows: beehiiv and
Mailchimp from the export fixtures in TryGhost/migrate (mg-beehiiv-members,
mg-mailchimp-members); Kit and MailerLite from their help-center descriptions
(literal header names are not published, see src/lib/csv.ts).
