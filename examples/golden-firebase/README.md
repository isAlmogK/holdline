# golden-firebase

Holdline's acceptance app for Firebase security rules. A project tracker whose data access is
governed by Firestore and Storage rules: users belong to organizations, organizations own projects,
projects have notes, and each organization has a Storage folder of files.

| File | What |
|---|---|
| `firestore.rules`, `storage.rules`, `firebase.json` | The security rules and config Holdline reads |
| `expected-rules.yaml` | The approved rules a careful engineer would write for this app |
| `breakages/R-xxx.patch` | One unified diff per rule, against this folder, that breaks exactly that rule |

The acceptance test (`packages/cli/test/golden-patch.test.ts`) copies this folder, applies each
patch, runs `holdline scan` and `holdline check`, and expects exactly that rule to fail. After
editing `expected-rules.yaml`, run
`pnpm tsx scripts/approve-fixture.ts examples/golden-firebase/expected-rules.yaml`.

## Rules

| Id | Type | What it shows |
|---|---|---|
| R-001 | data-access | A vocabulary `ref` (`signedIn()`) plus an `in` check through a `let`-bound `get()` in a helper |
| R-002 | data-access | The same helper on `request.resource.data` (`incoming.orgId`) for create |
| R-003 | data-access | A `get()` lookup keyed by a resource field, compared to a literal |
| R-004 | data-access | `{ or: [] }`: no client may delete (no `allow delete` at all) |
| R-005 | data-access | A Storage rule proving a Firestore `exists()` via `firestore.exists` |
| R-006 | invariant | not-null on a written field, from `request.resource.data.orgId != null` |
| R-007 | invariant | enum on a written field, from `status in [...]` |
| R-008 | data-access | An `in` check whose left side is itself a `get()` of the parent document |
| R-009 | data-access | An `exists()` membership check on a nested collection |
| R-010 | data-access | The caller's uid equals the path parameter |
| R-011 | data-access | `allow write` expands to create, update and delete in Storage |

## Breakages

| Patch | Edit | Only this rule fails because |
|---|---|---|
| R-001 | project read uses `orgIds.hasAny([resource.data.ownerOrg])` | `hasAny` is opaque, so read and list no longer prove the `in` lookup |
| R-002 | `allow create: if signedIn() && validProject();` | create no longer requires the caller's organizations; `validProject` keeps R-006 and R-007 |
| R-003 | `isOrgAdmin` returns `request.auth != null` | only update uses `isOrgAdmin` |
| R-004 | adds `allow delete: if isOrgAdmin(resource.data.orgId);` on projects | the delete requirement is `false` |
| R-005 | Storage `allow read: if request.auth != null;` | the membership `exists` is gone for read and list |
| R-006 | `validProject` drops `request.resource.data.orgId != null` | create and update no longer imply `incoming.orgId != null`; the `in` checks are unchanged |
| R-007 | status list becomes `['active', 'archived', 'deleted']` | the status list is wider than the enum |
| R-008 | notes `allow read: if signedIn();` | notes no longer check the organization |
| R-009 | adds `match /{document=**} { allow read: if request.auth != null; }` under `/orgs/{orgId}` | the catch-all overlaps only `/orgs/{orgId}/members/{uid}` among the rule targets |
| R-010 | users `allow read: if signedIn();` | the uid check is gone |
| R-011 | Storage `allow write` checks `request.auth != null` instead of `isMember(orgId)` | writes no longer require membership; reads keep it |
