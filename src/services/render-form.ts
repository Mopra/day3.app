// Renders the double opt-in confirmation email for a public-form signup. This is
// a transactional, self-contained template (no user-authored HTML), so unlike
// the campaign renderer it needs no sanitizer — only escaping of the few dynamic
// values that originate from account/form names.

export type FormConfirmationInput = {
  companyName: string;
  formName: string;
  confirmUrl: string;
  /** Optional accent for the confirm button (form.accentColor). */
  accentColor?: string | null;
};

export type RenderedConfirmation = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DEFAULT_ACCENT = "#111827";

export function renderFormConfirmationEmail(input: FormConfirmationInput): RenderedConfirmation {
  const company = escapeHtml(input.companyName);
  // confirmUrl is server-generated (HMAC token) and trusted — safe as an href.
  const url = input.confirmUrl;
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(input.accentColor ?? "")
    ? (input.accentColor as string)
    : DEFAULT_ACCENT;

  const subject = `Confirm your subscription to ${input.companyName}`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;">
            <tr><td>
              <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;">Confirm your subscription</h1>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">
                Please confirm you'd like to receive emails from <strong>${company}</strong>.
                Click the button below to complete your subscription — it only takes a second.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr><td style="border-radius:8px;background:${accent};">
                  <a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                    Confirm subscription
                  </a>
                </td></tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 20px;font-size:13px;line-height:1.6;word-break:break-all;">
                <a href="${url}" style="color:${accent};">${escapeHtml(url)}</a>
              </p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
                If you didn't request this, you can safely ignore this email — you won't be subscribed.
              </p>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `Confirm your subscription to ${input.companyName}

Please confirm you'd like to receive emails from ${input.companyName} by opening this link:

${input.confirmUrl}

If you didn't request this, you can safely ignore this email — you won't be subscribed.`;

  return { subject, html, text };
}
