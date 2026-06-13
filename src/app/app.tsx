import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@clerk/react";
import { AppShell } from "./components/shell";
import { RequireOrg } from "./components/require-org";
import { LandingPage } from "./pages/landing";
import { SignInPage, SignUpPage } from "./pages/auth";
import { SelectOrgPage } from "./pages/select-org";
import { DashboardPage } from "./pages/dashboard";
import { DomainsPage } from "./pages/domains";
import { AudiencesPage } from "./pages/audiences";
import { AudienceDetailPage } from "./pages/audience-detail";
import { CampaignsPage } from "./pages/campaigns";
import { CampaignNewPage } from "./pages/campaign-new";
import { CampaignDetailPage } from "./pages/campaign-detail";
import { BillingPage } from "./pages/billing";
import { SettingsPage } from "./pages/settings";
import { AdminOverviewPage } from "./pages/admin/overview";
import { AdminReviewsPage } from "./pages/admin/reviews";
import { AdminAccountPage } from "./pages/admin/account-detail";
import { UnsubscribePage } from "./pages/unsubscribe";

function Protected({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <RequireOrg>{children}</RequireOrg>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/sign-in/*" element={<SignInPage />} />
      <Route path="/sign-up/*" element={<SignUpPage />} />
      <Route path="/select-org" element={<SelectOrgPage />} />
      <Route path="/unsubscribe" element={<UnsubscribePage />} />

      <Route
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/domains" element={<DomainsPage />} />
        <Route path="/audiences" element={<AudiencesPage />} />
        <Route path="/audiences/:id" element={<AudienceDetailPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/new" element={<CampaignNewPage />} />
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminOverviewPage />} />
        <Route path="/admin/reviews" element={<AdminReviewsPage />} />
        <Route path="/admin/accounts/:id" element={<AdminAccountPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
