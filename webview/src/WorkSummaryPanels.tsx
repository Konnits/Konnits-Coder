import type {
  ChangeViewModel,
  TodoViewModel,
} from "../../src/webview/messages.js";
import { CollapsiblePanel } from "./CollapsiblePanel.js";
import { vscode } from "./vscode.js";

export function TodosPanel({
  todos,
}: {
  readonly todos: readonly TodoViewModel[];
}): React.JSX.Element {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return (
    <CollapsiblePanel
      title="Todos"
      count={`${String(completed)}/${String(todos.length)}`}
      headerAction={
        <button
          type="button"
          className="collapsible-panel-action"
          title="Clear todos"
          aria-label="Clear todos"
          onClick={() => vscode.postMessage({ type: "clearTodos" })}
        >
          Clear
        </button>
      }
    >
      <ol className="todo-list">
        {todos.map((todo) => (
          <li className={`todo-item todo-${todo.status}`} key={todo.id}>
            <span className="todo-status" aria-hidden="true">
              {todoStatus(todo.status)}
            </span>
            <span>{todo.content}</span>
          </li>
        ))}
      </ol>
    </CollapsiblePanel>
  );
}

export function ChangedFilesPanel({
  changes,
}: {
  readonly changes: readonly ChangeViewModel[];
}): React.JSX.Element {
  const pending = changes.filter((change) => change.status === "pending");
  const additions = changes.reduce(
    (total, change) => total + change.additions,
    0,
  );
  const deletions = changes.reduce(
    (total, change) => total + change.deletions,
    0,
  );
  const diffSummary =
    additions === 0 && deletions === 0
      ? undefined
      : `+${String(additions)} −${String(deletions)}`;
  return (
    <CollapsiblePanel
      title="Changed files"
      count={String(changes.length)}
      alwaysExpanded
      {...(diffSummary === undefined ? {} : { meta: diffSummary })}
    >
      <div className="change-list">
        {changes.map((change) => {
          const path = splitFilePath(change.path);
          return (
            <article
              className={`change change-${change.status}`}
              key={change.id}
            >
              <button
                className="file-link"
                title={`Review ${change.path}`}
                onClick={() =>
                  vscode.postMessage({ type: "reviewFile", id: change.id })
                }
              >
                <span
                  className={`change-kind change-kind-${change.kind}`}
                  title={changeKindLabel(change.kind)}
                >
                  {changeKindBadge(change.kind)}
                </span>
                <span className="file-description">
                  <strong className="file-name">{path.name}</strong>
                  {path.directory !== undefined && (
                    <span className="file-directory">{path.directory}</span>
                  )}
                </span>
                <span className="diff-stat">
                  <span className="additions">+{change.additions}</span>{" "}
                  <span className="deletions">-{change.deletions}</span>
                </span>
              </button>
              {change.conflictReason !== undefined && (
                <p className="conflict-reason">{change.conflictReason}</p>
              )}
              {change.status === "pending" ? (
                <div
                  className="file-actions"
                  aria-label={`Review ${change.path}`}
                >
                  <button
                    title={`Keep ${change.path}`}
                    onClick={() =>
                      vscode.postMessage({ type: "acceptFile", id: change.id })
                    }
                  >
                    Keep
                  </button>
                  <button
                    title={`Undo ${change.path}`}
                    onClick={() =>
                      vscode.postMessage({ type: "rejectFile", id: change.id })
                    }
                  >
                    Undo
                  </button>
                </div>
              ) : (
                <span
                  className={`change-resolution change-resolution-${change.status}`}
                >
                  {changeStatusLabel(change.status)}
                </span>
              )}
            </article>
          );
        })}
      </div>
      {pending.length > 0 && (
        <div className="button-row bulk-actions">
          <button
            className="primary"
            onClick={() => vscode.postMessage({ type: "acceptAll" })}
          >
            Keep all
          </button>
          <button onClick={() => vscode.postMessage({ type: "rejectAll" })}>
            Undo all
          </button>
        </div>
      )}
    </CollapsiblePanel>
  );
}

function todoStatus(status: TodoViewModel["status"]): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "◐";
    case "completed":
      return "✓";
  }
}

function splitFilePath(path: string): {
  readonly name: string;
  readonly directory?: string;
} {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.pop() ?? path;
  const directory = parts.join("/");
  return directory.length === 0 ? { name } : { name, directory };
}

function changeKindBadge(kind: ChangeViewModel["kind"]): string {
  switch (kind) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
  }
}

function changeKindLabel(kind: ChangeViewModel["kind"]): string {
  switch (kind) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
  }
}

function changeStatusLabel(status: ChangeViewModel["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "accepted":
      return "Kept";
    case "rejected":
      return "Undone";
    case "conflicted":
      return "Needs review";
  }
}
