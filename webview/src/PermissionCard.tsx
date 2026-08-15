import type { PermissionViewModel } from "../../src/webview/messages.js";

export function PermissionCard({
  permission,
  onDecision,
}: {
  readonly permission: PermissionViewModel;
  readonly onDecision: (decision: "allow" | "deny") => void;
}): React.JSX.Element {
  return (
    <section
      className={`permission permission-${permission.risk}`}
      aria-live="assertive"
    >
      <div className="eyebrow">
        {permission.risk === "dangerous"
          ? "Potentially destructive"
          : permission.risk === "command"
            ? "Command permission"
            : "Write permission"}
      </div>
      <strong>{permission.title}</strong>
      {permission.detail !== undefined && <code>{permission.detail}</code>}
      <div className="button-row">
        <button className="primary" onClick={() => onDecision("allow")}>
          Allow
        </button>
        <button onClick={() => onDecision("deny")}>Deny</button>
      </div>
    </section>
  );
}
