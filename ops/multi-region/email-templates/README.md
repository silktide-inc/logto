# Branded auth emails

Ported from the Auth0 templates Marvel installs via `Auth0Installer::updateEmailTemplates()`
(`marvel/src/citadel/Auth/Auth0/Templates/Email/` in silktide-qa). Same chrome — logo header,
blurple panel, legal footer — with one structural change: Auth0 emails carried a ticket **link**
(`{{ url }}`), while Logto's built-in flows send a **verification code**, so the button became a
`{{code}}` display.

`seed.mjs` uploads these per region with `PUT /api/email-templates` (language tag `en`). Those
DB-backed templates take priority over the plain-text fallbacks in the SMTP connector config,
which exist only because the connector refuses a config without entries for
`Register`/`SignIn`/`ForgotPassword`/`Generic`.

## Mapping

| Auth0 template (Marvel)  | Logto `templateType` | Notes                                                        |
| ------------------------ | -------------------- | ------------------------------------------------------------ |
| `ResetPassword.html`     | `ForgotPassword`     | Reset-only. Auth0 doubled this as the welcome email (Liquid branch on `user.email_verified`); in Logto the welcome/"set first password" email is a separate flow we send ourselves with a one-time-token magic link. |
| `MFAVerification.html`   | `MfaVerification`    | Direct port. (Disabled in Auth0's map; enabled here — Logto needs it for email MFA.) |
| `MFAEnrolment.html`      | `BindMfa`            | Auth0 sent an enrolment ticket link; Logto sends a code when binding email MFA. |
| —                        | `Generic`            | New. Fallback + what the Console "send test email" uses.     |
| `BlockedAccount.html`    | —                    | Not ported: Auth0 anomaly-detection feature with no Logto flow. Send from our side if we still want it. |
| `StolenCredentials.html` | —                    | Not ported: same reason (breached-password detection is Auth0-specific). |

## SetPasswordLink.html — the Auth0-identical reset/welcome email

Not seeded into Logto (Logto never sends it). This is the port of Auth0's `ResetPassword.html`
**with the button**, for the link-based flow that services/auth owns:

1. `POST /api/one-time-tokens` (Management API, M2M credentials) mints a token for the email.
2. services/auth sends this template with `{{ url }}` pointing at the portal's set-password
   page (`?token=...&email=...`), choosing `{{ heading }}`/`{{ lead }}` and the subject per
   flow — "Welcome to Silktide" vs "Reset your password" — which replaces Auth0's Liquid
   conditional on `user.email_verified`.
3. The portal posts the new password to services/auth, which calls
   `POST /api/one-time-tokens/verify` (consumes the token) then `PATCH /api/users/:id/password`.
   That endpoint does **not** enforce the tenant password policy — services/auth must validate
   the password itself.

The seeded code-based `ForgotPassword` template remains as a fallback for Logto's hosted
forgot-password flow, which stays disabled (`forgotPasswordMethods: []`).

## Placeholders

- `{{code}}` — replaced by Logto's connector at send time.
- `{{ legal_entity_line }}` / `{{ legal_trademark_holder }}` — replaced by `seed.mjs` at seed
  time, mirroring `Auth0Installer::applyLegalFooterPlaceholders()` (Marvel config keys
  `legal.entity_line` / `legal.trademark_holder`).

Subjects live in `seed.mjs` next to the file names (Auth0 kept them in
`EmailTemplatesMap.php`); `user.name` is not available in Logto payloads, so the personalized
welcome heading did not carry over.
