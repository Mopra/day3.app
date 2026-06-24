import type { Metadata } from "next";
import { LegalShell } from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy — Day3",
  description: "How Day3 collects, uses, and protects personal data.",
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" lastUpdated="24 June 2026">
      <p>
        This Privacy Policy explains how Day3 (&quot;Day3&quot;, &quot;we&quot;, &quot;us&quot;),
        operated by <em>Pradsgaard Labs, Bogfinkevej 2, 7400 Herning, Denmark</em>, collects and processes
        personal data when you use our newsletter-sending service (the &quot;Service&quot;).
      </p>

      <h2>1. Our role: controller vs. processor</h2>
      <p>
        For data about <strong>you, our customer</strong> (account, billing, and login
        information), Day3 is the <strong>data controller</strong>. For the{" "}
        <strong>subscriber data you upload and send to</strong> (your contacts&apos; email
        addresses, names, and engagement), <strong>you are the controller and Day3 is your
        processor</strong>, processing that data only on your instructions and as described
        in these terms and this policy. A separate data processing agreement is available on
        request.
      </p>

      <h2>2. Data we collect</h2>
      <ul>
        <li>
          <strong>Account data</strong> — name, email, organisation, and authentication
          handled by our auth provider (Clerk).
        </li>
        <li>
          <strong>Billing data</strong> — plan, subscription status, and payment metadata
          (we do not store full card numbers).
        </li>
        <li>
          <strong>Subscriber data</strong> — the contact lists you import (email, optional
          first/last name) and consent metadata (e.g. signup timestamp and IP for
          double-opt-in).
        </li>
        <li>
          <strong>Email engagement</strong> — deliveries, bounces, complaints, opens, and
          clicks, used to report campaign performance and protect deliverability.
        </li>
        <li>
          <strong>Technical data</strong> — logs, IP addresses, and diagnostic information
          needed to operate and secure the Service.
        </li>
      </ul>

      <h2>3. How we use data</h2>
      <ul>
        <li>To provide, maintain, and secure the Service.</li>
        <li>To send the campaigns you create, to the recipients you choose.</li>
        <li>
          To protect sending reputation — e.g. suppressing addresses that hard-bounce or
          mark mail as spam, and pausing sending when complaint rates are too high.
        </li>
        <li>To handle billing and provide support.</li>
        <li>To comply with legal obligations.</li>
      </ul>

      <h2>4. Sub-processors</h2>
      <p>We rely on the following providers to deliver the Service:</p>
      <ul>
        <li>
          <strong>Clerk</strong> — authentication and organisation/billing management.
        </li>
        <li>
          <strong>Amazon Web Services (SES)</strong> — email delivery and sender identity
          verification.
        </li>
        <li>
          <strong>Supabase</strong> — managed Postgres database and file storage (region:{" "}
          <em>Central EU (Frankfurt)</em>).
        </li>
        <li>
          <strong>Vercel</strong> — application hosting.
        </li>
        <li>
          <strong>OpenRouter</strong> — optional AI drafting features (only invoked when you
          use them; email content you submit is processed to generate suggestions).
        </li>
        <li>
          <strong>Hostinger VPS, Central EU (Frankfurt)</strong> — background job queue.
        </li>
      </ul>
      <p>
        A current list of sub-processors is available on request at{" "}
        <a href="mailto:connect@day3.app">connect@day3.app</a>.
      </p>

      <h2>5. Cookies &amp; tracking</h2>
      <p>
        Our app uses <strong>essential cookies</strong> only (for login/session). We do not
        use advertising cookies. Within the emails you send, Day3 can embed an open-tracking
        pixel and rewrite links for click tracking; you control whether these are enabled,
        and recipients can always unsubscribe via the link in every email.
      </p>

      <h2>6. Data retention</h2>
      <p>
        We retain account and subscriber data for as long as your account is active. Email
        engagement/event data is retained for <em>12 months</em>,
        after which it is deleted or aggregated. When you delete a subscriber, or your
        account, we delete the associated personal data within <em>30 days</em>, except
        where we must retain it to meet legal obligations.
      </p>

      <h2>7. Your rights</h2>
      <p>
        Subject to applicable law (including the GDPR), you may have the right to access,
        correct, delete, restrict, or port your personal data, and to object to certain
        processing. To exercise these rights, contact{" "}
        <a href="mailto:connect@day3.app">connect@day3.app</a>. If you are a recipient of an
        email sent through Day3, please contact the sender (our customer), who is the
        controller of that data; we will assist them in responding.
      </p>

      <h2>8. International transfers &amp; security</h2>
      <p>
        Data may be processed in regions where we or our sub-processors operate; where
        required, transfers are covered by appropriate safeguards (e.g. Standard Contractual
        Clauses). We apply technical and organisational measures to protect personal data,
        including encryption in transit and access controls.
      </p>

      <h2>9. Changes &amp; contact</h2>
      <p>
        We may update this policy; material changes will be posted here with a new date.
        Questions or requests: <a href="mailto:connect@day3.app">connect@day3.app</a>{" "}
        (or our postal address: <em>Bogfinkevej 2, 7400 Herning, Denmark</em>).
      </p>
    </LegalShell>
  );
}
