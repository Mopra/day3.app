export type RenderInput = {
  campaign: {
    subject: string;
    htmlBody: string;
    textBody?: string | null;
  };
  subscriber: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  companyName: string;
  companyAddress?: string | null;
  unsubscribeUrl: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const FOOTER_HTML = `
<hr>
<p>You are receiving this email because you subscribed to updates from {{company_name}}.</p>
<p>{{company_address}}</p>
<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
`;

const FOOTER_TEXT = `

--
You are receiving this email because you subscribed to updates from {{company_name}}.
{{company_address}}
Unsubscribe: {{unsubscribe_url}}
`;

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : "";
  });
}

// Strips tags well enough for a fallback text body. Not a full HTML parser —
// campaign HTML here is simple newsletter markup.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderCampaignEmail(input: RenderInput): RenderedEmail {
  const vars: Record<string, string> = {
    first_name: input.subscriber.firstName ?? "",
    last_name: input.subscriber.lastName ?? "",
    email: input.subscriber.email,
    company_name: input.companyName,
    company_address: input.companyAddress ?? "",
    unsubscribe_url: input.unsubscribeUrl,
  };

  let html = input.campaign.htmlBody;
  if (!html.includes("{{unsubscribe_url}}")) {
    html += FOOTER_HTML;
  }

  let text = input.campaign.textBody?.trim()
    ? input.campaign.textBody
    : htmlToText(input.campaign.htmlBody);
  if (!text.includes("{{unsubscribe_url}}")) {
    text += FOOTER_TEXT;
  }

  return {
    subject: substitute(input.campaign.subject, vars),
    html: substitute(html, vars),
    text: substitute(text, vars),
  };
}
