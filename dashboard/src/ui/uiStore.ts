import type { AgentId } from "../contract/events";
import { createStore } from "../state/store";

export type Tab = "summary" | "tasks" | "git";
export const TABS: Tab[] = ["summary", "tasks", "git"];

export interface UiState {
  /** The selected edge's DM ("a|b", sorted). Null shows #team. */
  chat: string | null;
  /** Show both agents' activity between DM messages. Off by default: messages first. */
  showActivity: boolean;
  /** The details drawer over the canvas. Null when closed. */
  drawer: { kind: "tab"; tab: Tab } | { kind: "agent"; id: AgentId } | null;
  selectedTask?: string;
  selectedCommit?: string;
  /** Bumped to move keyboard focus into the composer. */
  focusComposer: number;
}

export const ui = createStore<UiState>({
  chat: null,
  showActivity: false,
  drawer: null,
  focusComposer: 0,
});

export const actions = {
  openTab(tab: Tab) {
    ui.set({ drawer: { kind: "tab", tab } });
  },
  selectAgent(id: AgentId) {
    ui.set({ drawer: { kind: "agent", id } });
  },
  selectTask(id: string) {
    ui.set({ selectedTask: id, drawer: { kind: "tab", tab: "tasks" } });
  },
  selectCommit(sha: string) {
    ui.set({ selectedCommit: sha, drawer: { kind: "tab", tab: "git" } });
  },
  closeDrawer() {
    ui.set({ drawer: null });
  },
  /** Select an edge, showing its DM. Selecting the same edge again goes back to #team. */
  toggleChat(key: string) {
    ui.set((s) => ({ chat: s.chat === key ? null : key }));
  },
  openChat(key: string | null) {
    ui.set({ chat: key });
  },
  messageOrchestrator(key: string) {
    ui.set((s) => ({ chat: key, focusComposer: s.focusComposer + 1 }));
  },
  toggleActivity() {
    ui.set((s) => ({ showActivity: !s.showActivity }));
  },
};
