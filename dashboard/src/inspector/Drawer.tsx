import { useUi } from "../app/context";
import { setTheme, THEMES, type ThemeName, useTheme } from "../ui/theme";
import { actions, TABS } from "../ui/uiStore";
import { AgentDetail } from "./Details";
import { Git } from "./Git";
import { Summary } from "./Summary";
import { Tasks } from "./Tasks";

const PANELS = { summary: Summary, tasks: Tasks, git: Git };

export const DRAWER_WIDTH = 380;

/** Run details in a drawer over the left of the canvas, so the chat stays visible. */
export function Drawer() {
  const drawer = useUi((u) => u.drawer);
  if (!drawer) return null;
  const Panel = drawer.kind === "tab" ? PANELS[drawer.tab] : undefined;
  return (
    <aside
      aria-label="details"
      className="absolute inset-y-0 left-0 z-20 flex flex-col border-r-2 border-ink bg-card"
      style={{ width: DRAWER_WIDTH }}
    >
      <div className="atoi-panel-header flex shrink-0 items-stretch border-b-2 border-ink">
        <div role="tablist" aria-label="details tabs" className="flex flex-1">
          {TABS.map((t, i) => {
            const active = drawer.kind === "tab" && drawer.tab === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                title={`${t} (${i + 1})`}
                onClick={() => actions.openTab(t)}
                className={`atoi-label flex-1 py-2 text-title ${active ? "bg-hub font-semibold" : "text-muted hover:bg-hub hover:text-ink"}`}
              >
                {t}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={actions.closeDrawer}
          aria-label="Close details (Esc)"
          title="Close (Esc)"
          className="border-l-2 border-ink px-3 text-title hover:bg-hub"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden break-words px-4 py-4">
        {Panel ? <Panel /> : drawer.kind === "agent" ? <AgentDetail id={drawer.id} /> : null}
      </div>
    </aside>
  );
}

/** Canvas corner controls: open the details drawer, and (exploration) switch themes. */
export function DrawerToggle() {
  const open = useUi((u) => !!u.drawer);
  const theme = useTheme();
  if (open) return null;
  return (
    <div className="absolute left-3 top-3 z-10 flex gap-2">
      <button
        type="button"
        onClick={() => actions.openTab("summary")}
        title="Run details (1)"
        className="atoi-label rounded-box border-2 border-ink bg-card px-2 text-body leading-[28px] hover:bg-hub"
      >
        details
      </button>
      <label className="atoi-label flex items-center gap-1.5 rounded-box border border-line bg-card px-2 text-chip text-muted">
        theme
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeName)}
          className="bg-card py-1 text-chip text-ink"
        >
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
