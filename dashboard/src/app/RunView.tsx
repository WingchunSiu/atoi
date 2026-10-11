import { useEffect, useState } from "react";
import { ActivityEngine, prefersReducedMotion } from "../canvas/activity";
import { MeshCanvas } from "../canvas/MeshCanvas";
import { ThemeDefs } from "../canvas/ScenicBackdrop";
import { ChatPanel } from "../chat/ChatPanel";
import { USER_ID } from "../contract/events";
import { DRAWER_WIDTH, Drawer, DrawerToggle } from "../inspector/Drawer";
import type { RunSummary } from "../sources/live";
import type { RunSource, SourceStatus } from "../sources/types";
import { RunStore } from "../state/runStore";
import { createStore } from "../state/store";
import { ConnectionStrip, MockStrip, TopBar } from "../topbar/TopBar";
import { actions, TABS, ui } from "../ui/uiStore";
import { type Outgoing, RunContext, type RunContextValue, useUi } from "./context";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        // Close the drawer first, then leave a DM for #team.
        if (ui.get().drawer) actions.closeDrawer();
        else if (ui.get().chat) actions.openChat(null);
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === "1" || e.key === "2" || e.key === "3")
        actions.openTab(TABS[Number(e.key) - 1]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function RunView({ source, runs }: { source: RunSource; runs: RunSummary[] }) {
  const [ctx] = useState<RunContextValue>(() => ({
    store: new RunStore(source.runId),
    activity: new ActivityEngine(prefersReducedMotion),
    source,
    status: createStore<{ status: SourceStatus; since: number }>({
      status: { state: "connecting" },
      since: Date.now(),
    }),
    outbox: createStore<{ items: Outgoing[] }>({ items: [] }),
    runs,
  }));

  useEffect(() => {
    const { store, activity, status } = ctx;
    // Dev-only handle for QA scripts.
    if (import.meta.env.DEV) (window as unknown as { __atoi: RunContextValue }).__atoi = ctx;
    const offAdvance = store.onAdvance((fresh, state) => activity.handle(fresh, state));
    let openedChat = false;
    const stop = source.start({
      snapshot: (state) => {
        store.hydrate(state);
        if (source.kind === "live" && !openedChat) {
          const orchestrator = state.agentOrder.find(
            (id) => state.agents[id]?.kind === "orchestrator",
          );
          if (orchestrator) {
            actions.openChat([USER_ID, orchestrator].sort().join("|"));
            openedChat = true;
          }
        }
      },
      event: (e) => store.append(e),
      malformed: () => store.markSkipped(),
      status: (s) => status.set({ status: s, since: Date.now() }),
    });
    return () => {
      stop();
      offAdvance();
      activity.dispose();
    };
  }, [ctx, source]);

  useShortcuts();
  const drawerOpen = useUi((u) => !!u.drawer);

  return (
    <RunContext.Provider value={ctx}>
      <ThemeDefs />
      <div className="grid h-full grid-cols-[minmax(0,1fr)_400px] grid-rows-[auto_minmax(0,1fr)] min-[1281px]:grid-cols-[minmax(0,1fr)_460px] max-lg:flex max-lg:h-auto max-lg:flex-col">
        <div className="col-span-2">
          <MockStrip />
          <ConnectionStrip />
          <TopBar />
        </div>
        <main
          className="relative min-h-0 min-w-0 overflow-hidden max-lg:h-[560px]"
          aria-label="agent mesh"
        >
          <MeshCanvas inset={drawerOpen ? DRAWER_WIDTH : 0} />
          <DrawerToggle />
          <Drawer />
        </main>
        <div className="flex min-h-0 min-w-0 max-lg:h-[640px]">
          <ChatPanel />
        </div>
      </div>
    </RunContext.Provider>
  );
}
