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
        <div className="suggestion-empty">No Qwen commands available</div>
      ) : kind === "reference" && references.length === 0 ? (
        <div className="suggestion-empty">No workspace files match</div>
      ) : kind === "command" ? (
        commands.map((command, index) => (
          <SuggestionItem
            key={command.name}
            index={index}
            selected={index === highlightedIndex}
            main={command.name}
            detail={formatCommandDetail(command)}
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
            detail={reference.kind}
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
  readonly detail: string;
  readonly onHighlight: (index: number) => void;
  readonly onSelect: () => void;
}

function SuggestionItem({
  index,
  selected,
  main,
  detail,
  onHighlight,
  onSelect,
}: SuggestionItemProps): React.JSX.Element {
  return (
    <button
      className={`suggestion-item${selected ? " suggestion-selected" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => onHighlight(index)}
      onClick={onSelect}
    >
      <span className="suggestion-main">{main}</span>
      <span className="suggestion-detail">{detail}</span>
    </button>
  );
}

function formatCommandDetail(command: SlashCommandSuggestion): string {
  return [command.description, command.argumentHint, command.source]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" · ");
}
