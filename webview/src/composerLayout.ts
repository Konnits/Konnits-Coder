export const COMPOSER_MAX_HEIGHT_PX = 180;

interface ResizableTextarea {
  readonly scrollHeight: number;
  readonly style: {
    height: string;
    overflowY: string;
  };
}

export function resizeComposerTextarea(textarea: ResizableTextarea): void {
  textarea.style.height = "0px";
  const height = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
  textarea.style.height = `${String(height)}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
}

export function moveSuggestionHighlight(
  current: number,
  direction: -1 | 1,
  count: number,
): number {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(current + direction, count - 1));
}
