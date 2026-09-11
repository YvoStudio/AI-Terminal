interface NotepadView {
  handleNotepadOutsideClick(target: Node): void;
}

/** Capture before xterm/context menus can stop bubbling. Exactly one layer is
 * dismissed per mousedown; queue-owned portals must not dismiss their parent. */
export function registerNotepadDismiss(
  getViews: () => Iterable<NotepadView>,
  root: Document = document,
): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as Node | null;
    if (!target) return;
    const element = target.nodeType === 1 ? target as Element : target.parentElement;
    if (element?.closest('.image-preview-overlay, .skill-menu')) return;
    for (const view of getViews()) view.handleNotepadOutsideClick(target);
  };
  root.addEventListener('mousedown', onMouseDown, true);
  return () => root.removeEventListener('mousedown', onMouseDown, true);
}
