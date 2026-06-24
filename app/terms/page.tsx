import type { Metadata } from "next";
import { LegalShell } from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Terms of Service — Day3",
  description: "The terms governing your use of Day3.",
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" lastUpdated="24 June 2026">
      <p>
        These Terms govern your access to and use of Day3 (the &quot;Service&quot;), operated
        by <em>Pradsgaard Labs, Bogfinkevej 2, 7400 Herning, Denmark</em>. By creating an account or using the
        Service, you agree to these Terms.
      </p>

      <h2>1. The Service</h2>
      <p>
        Day3 lets small teams import contacts, compose, and send product-update emails. The
        free tier is set-up-only (you can configure everything and draft, but not send, and
        are limited to 500 subscribers); paid tiers unlock sending under a bandwidth-based
        pricing model.
      </p>

      <h2>2. Accounts &amp; eligibility</h2>
      <p>
        You must provide accurate information, keep your credentials secure, and be
        responsible for activity under your account. You must be legally able to enter into
        these Terms.
      </p>

      <h2>3. Acceptable use &amp; anti-spam</h2>
      <p>You agree that you will:</p>
      <ul>
        <li>
          <strong>Only email people who have given you permission</strong> to do so. No
          purchased, rented, scraped, or third-party lists.
        </li>
        <li>
          Comply with all applicable laws, including the <strong>CAN-SPAM Act</strong>, GDPR,
          and CASL — including a valid physical postal address and a working unsubscribe
          mechanism in every campaign (Day3 appends these automatically).
        </li>
        <li>Honour unsubscribe requests promptly and not attempt to bypass suppression.</li>
        <li>Not send unlawful, deceptive, harmful, or infringing content.</li>
      </ul>
      <p>
        To protect deliverability for all customers, we monitor bounce and complaint rates
        and <strong>may automatically pause or suspend sending</strong> that exceeds safe
        thresholds, and may remove content or terminate accounts that violate this section.
      </p>

      <h2>4. Your data &amp; data protection</h2>
      <p>
        You retain ownership of the contact and content data you upload. With respect to
        personal data of your subscribers, you are the controller and Day3 is your processor;
        our processing is governed by our Privacy Policy, and a separate data processing
        agreement is available on request. You are responsible for having a lawful basis to
        process and email your contacts.
      </p>

      <h2>5. Plans, billing &amp; changes</h2>
      <p>
        Paid plans are billed through our billing provider on a recurring basis. Limits and
        pricing are described in the app. We may change pricing or features with reasonable
        notice. Failure to pay may result in suspension of sending. You can cancel at any
        time; your subscription stays active until the end of the current billing period and
        then expires automatically. Payments are non-refundable.
      </p>

      <h2>6. Suspension &amp; termination</h2>
      <p>
        You may stop using the Service at any time. We may suspend or terminate access for
        breach of these Terms, legal risk, or threats to the Service or its other users. On
        termination, you may request export of your data for a limited period, after which it
        may be deleted per our Privacy Policy.
      </p>

      <h2>7. Disclaimers &amp; limitation of liability</h2>
      <p>
        The Service is provided &quot;as is&quot; without warranties of any kind. To the
        maximum extent permitted by law, Day3 is not liable for indirect, incidental, or
        consequential damages, and our total liability is limited to the amounts you paid in
        the 12 months preceding the claim.
      </p>

      <h2>8. Governing law &amp; contact</h2>
      <p>
        These Terms are governed by the laws of Denmark. Questions:{" "}
        <a href="mailto:connect@day3.app">connect@day3.app</a>.
      </p>
    </LegalShell>
  );
}
