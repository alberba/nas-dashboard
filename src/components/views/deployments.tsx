"use client";
import { DeploymentProgress, ReleaseDetails } from "./deployment-details";
import { MaintenanceSnapshotProvider } from "./use-maintenance-snapshot";
import { RenovatePanel } from "./renovate-panel";
export function Deployments() {
  return (
    <MaintenanceSnapshotProvider>
      <div className="page-stack">
        <ReleaseDetails>
          <RenovatePanel />
          <DeploymentProgress />
        </ReleaseDetails>
      </div>
    </MaintenanceSnapshotProvider>
  );
}
