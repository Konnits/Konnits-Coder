import type {
  SlashCommandSuggestion,
  WorkspaceReferenceSuggestion,
} from "../../src/webview/messages.js";

interface SuggestionPopupProps {
  readonly kind: "command" | "reference";
  readonly commands: readonly SlashCommandSuggestion[];
  readonly references: readonly WorkspaceReferenceSuggestion[];
  readonly highlightedIndex: number;
  readonly onHighlight: (index: number) => void;
  readonly onSelectCommand: (command: SlashCommandSuggestion) => void;
  readonly onSelectReference: (reference: WorkspaceReferenceSuggestion) => void;
}

export function SuggestionPopup({
  kind,
  commands,
  references,
  highlightedIndex,
  onHighlight,
  onSelectCommand,
  onSelectReference,
}: SuggestionPopupProps): React.JSX.Element {
  return (
    <div className="suggestion-popup" role="listbox" aria-label="Suggestions">
      {kind === "command" && commands.length === 0 ? (
        <div className="suggestion-empty">No commands available</div>
      ) : kind === "reference" && references.length === 0 ? (
        <div className="suggestion-empty">No workspace files match</div>
      ) : kind === "command" ? (
        commands.map((command, index) => (
          <SuggestionItem
            key={command.id}
            index={index}
            selected={index === highlightedIndex}
            main={command.command}
            source={formatCommandSource(command)}
            description={command.description}
            unavailable={!command.available}
            {...(command.usage === undefined ? {} : { usage: command.usage })}
            {...(command.aliases === undefined
              ? {}
              : { aliases: command.aliases })}
            onHighlight={onHighlight}
            onSelect={() => onSelectCommand(command)}
          />
        ))
      ) : (
        references.map((reference, index) => (
          <SuggestionItem
            key={reference.id}
            index={index}
            selected={index === highlightedIndex}
            main={`@${reference.displayName}`}
            source={reference.kind}
            onHighlight={onHighlight}
            onSelect={() => onSelectReference(reference)}
          />
        ))
      )}
    </div>
  );
}

interface SuggestionItemProps {
  readonly index: number;
  readonly selected: boolean;
  readonly main: string;
  readonly source: string;
  readonly description?: string;
  readonly usage?: string;
  readonly aliases?: readonly string[];
  readonly unavailable?: boolean;
  readonly onHighlight: (index: number) => void;
  readonly onSelect: () => void;
}

function SuggestionItem({
  index,
  selected,
  main,
  source,
  description,
  usage,
  aliases,
  unavailable = false,
  onHighlight,
  onSelect,
}: SuggestionItemProps): React.JSX.Element {
  return (
    <button
      className={`suggestion-item${selected ? " suggestion-selected" : ""}${unavailable ? " suggestion-unavailable" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => onHighlight(index)}
      onClick={onSelect}
    >
      <span className="suggestion-main-row">
        <span className="suggestion-main">{main}</span>
        <span className="suggestion-source">{source}</span>
      </span>
      {description !== undefined && (
        <span className="suggestion-description">{description}</span>
      )}
      {usage !== undefined && (
        <span className="suggestion-usage">Usage: {usage}</span>
      )}
      {aliases !== undefined && aliases.length > 0 && (
        <span className="suggestion-usage">Aliases: {aliases.join(", ")}</span>
      )}
    </button>
  );
}

function formatCommandSource(command: SlashCommandSuggestion): string {
  if (!command.available) return "Unavailable";
  if (command.source === "konnits") return "Konnits";
  switch (command.origin) {
    case "builtin":
      return "Built-in";
    case "project":
      return "Project";
    case "user":
      return "User";
    case "skill":
      return "Skill";
    case "mcp":
      return "MCP";
    case "extension":
      return "Extension";
    case "qwen":
    case undefined:
      return "Qwen SDK";
    case "unknown":
      return "Unknown";
    default:
      return "Qwen SDK";
  }
}
