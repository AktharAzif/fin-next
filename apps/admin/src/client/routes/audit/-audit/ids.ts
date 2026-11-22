// The IDs AdminAudit reads from its URL and sends, in exactly the shape the API half takes
// (`<prefix>_` and 26 characters of lower-case Crockford base32, as @fin/staff's read and the
// route's query schema check them), so a link the API would refuse is dropped, never sent. Kept
// apart from the contract, with no imports, because the route's `validateSearch` (search.ts) is
// in the app's first bundle.
export const AUDIT_ID = /^aud_[0-9a-hjkmnp-tv-z]{26}$/;
export const STAFF_ID = /^stf_[0-9a-hjkmnp-tv-z]{26}$/;
export const ORG_ID = /^org_[0-9a-hjkmnp-tv-z]{26}$/;
