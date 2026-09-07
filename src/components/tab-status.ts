import type { TabStatus } from '../api';

interface TabVisibility {
  windowHasFocus: boolean;
  activeTabId: string | null;
  splitState: { panes: ReadonlyArray<{ activeTabId: string }> } | null;
}

/** A displayed split pane is only seen while the application has focus. */
export function isTabSeen(tabId: string, visibility: TabVisibility): boolean {
  if (!visibility.windowHasFocus) return false;
  if (visibility.splitState) {
    return visibility.splitState.panes.some(pane => pane.activeTabId === tabId);
  }
  return visibility.activeTabId === tabId;
}

/** Acknowledging a result must never acknowledge a still-running task. */
export function acknowledgeTabStatus(status: TabStatus, seen: boolean): TabStatus {
  return seen && (status === 'done-unseen' || status === 'waiting') ? 'active' : status;
}

/** Backend completion is already debounced. Do not guess from elapsed time or
 * treat an idle prompt (Waiting) as a new completion. Live execution always
 * takes priority over an unread result from the previous turn. */
export function nextTabStatus(current: TabStatus, incoming: TabStatus, seen: boolean): TabStatus {
  if (incoming === 'waiting') {
    return acknowledgeTabStatus(current === 'done-unseen' ? current : 'active', seen);
  }
  return acknowledgeTabStatus(incoming, seen);
}
