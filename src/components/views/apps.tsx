import { ArrowUpRight } from "lucide-react";
import { applications } from "@/lib/apps";

export function AppsView({ appDomain }: { appDomain: string }) {
  return (
    <div className="apps-grid">
      {applications.map((app) => (
        <a
          key={app.host}
          href={`https://${app.host}.${appDomain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="panel app-card"
        >
          <div className="section-heading">
            <span className={`app-letter ${app.tone}`}>{app.letter}</span>
            <ArrowUpRight />
          </div>
          <span className="subtle app-category">{app.category}</span>
          <h2>{app.name}</h2>
          <span className="app-url">
            {app.host}.{appDomain}
          </span>
        </a>
      ))}
    </div>
  );
}
