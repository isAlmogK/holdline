# golden-firebase

Holdline's acceptance app for Firebase security rules. A web app whose data access is governed by
Firestore and Storage rules.

| File | What |
|---|---|
| `firestore.rules`, `storage.rules`, `firebase.json` | The security rules and config Holdline reads |
| `expected-rules.yaml` | The approved rules a careful engineer would write for this app |
| `breakages/R-xxx.patch` | One unified diff per rule, against this folder, that breaks exactly that rule |

The acceptance test (`packages/cli/test/golden-patch.test.ts`) copies this folder, applies each
patch, runs `holdline scan` and `holdline check`, and expects exactly that rule to fail. The
Firestore track (spec: docs/superpowers/specs/2026-10-21-data-layers-design.md, section 6.2) fills in
the app, rules and breakages.
