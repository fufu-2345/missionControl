import * as vscode from "vscode";

import { accountsCommand } from "./commands/accountsPanel";
import { approveCommand } from "./commands/approve";
import { budgetCommand } from "./commands/budget";
import { claudeCommand } from "./commands/claude";
import { dashboardCommand } from "./commands/dashboard";
import { installCommand } from "./commands/install";
import { mawToggleCommand } from "./commands/mawServe";
import { settingsCommand } from "./commands/settingsPanel";
import { setupCommand } from "./commands/setup";
import { skillsCommand } from "./commands/skills";
import { teamsCommand } from "./commands/teamsPanel";
import { startCommand } from "./commands/start";
import { startOrchestratorCommand } from "./commands/startOrchestrator";
import { statusCommand } from "./commands/status";
import { terminalCommand } from "./commands/terminal";
import { PROJECT_STATE_KEY, setCurrentProjectId } from "./projectState";
import { registerStatusBar } from "./statusBar";
import { openOrchestratorPanel } from "./webview/orchestrator";
import { registerSidebar } from "./webview/sidebar";
import { openIdeasPanel, type Idea } from "./webview/ideas";
import { openPRPanel, type PRInfo } from "./webview/pr";
import { WSClient } from "./ws";

export function activate(context: vscode.ExtensionContext) {
  // Restore the last-used project_id from the workspace's globalState BEFORE
  // wiring up api/ws/sidebar — so the first /healthz, /projects, and WS
  // hello already carry the right `X-Project-Id` / subscription. Without
  // this, the user sees an empty dropdown for a beat on startup.
  const savedPid = context.globalState.get<string | null>(PROJECT_STATE_KEY, null);
  if (savedPid) setCurrentProjectId(savedPid);

  const registrations: vscode.Disposable[] = [
    vscode.commands.registerCommand("missioncontrol.install", () => installCommand(context)),
    vscode.commands.registerCommand("missioncontrol.setup", () => setupCommand(context)),
    vscode.commands.registerCommand("missioncontrol.start", () => startCommand(context)),
    vscode.commands.registerCommand("missioncontrol.status", () => statusCommand(context)),
    vscode.commands.registerCommand("missioncontrol.approve", () => approveCommand(context)),
    vscode.commands.registerCommand("missioncontrol.budget", () => budgetCommand(context)),
    vscode.commands.registerCommand("missioncontrol.skills", () => skillsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.teams", () => teamsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.accounts", () => accountsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.settings", () => settingsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.dashboard", () => dashboardCommand(context)),
    vscode.commands.registerCommand("missioncontrol.claude", () => claudeCommand(context)),
    vscode.commands.registerCommand("missioncontrol.mawToggle", () => mawToggleCommand(context)),
    vscode.commands.registerCommand("missioncontrol.terminal", () => terminalCommand(context)),
    vscode.commands.registerCommand("missioncontrol.startOrchestrator", () => startOrchestratorCommand(context)),
    vscode.commands.registerCommand("missioncontrol.orchestratorContinue", () =>
      openOrchestratorPanel(context),
    ),
  ];
  context.subscriptions.push(...registrations);

  registerStatusBar(context);
  registerSidebar(context);

  // WS client — listens for ideas_ready and auto-opens swipe panel.
  // The ws_server already filters events by the client's set_project_ids, so
  // anything that arrives here is for a project this tab cares about. We
  // still capture event.data.project_id and pass it to the panel so click-
  // time actions (approve, merge) target the SAME project the event came
  // from — even if the user has since switched the sidebar to a different
  // project. Backend includes project_id in every payload by convention.
  const ws = new WSClient();
  ws.on((ev) => {
    if (ev.event === "ideas_ready") {
      const data = ev.data as { ideas?: Idea[]; project_id?: string };
      if (Array.isArray(data.ideas) && data.ideas.length > 0) {
        openIdeasPanel(data.ideas, data.project_id ?? null);
      }
    } else if (ev.event === "pr_ready") {
      const data = ev.data as PRInfo & { project_id?: string };
      openPRPanel(data, data.project_id ?? null);
    } else if (ev.event === "agent_progress") {
      const d = ev.data as { agent?: string; status?: string };
      vscode.window.setStatusBarMessage(
        `Mission Control: ${d.agent ?? "agent"} ${d.status ?? ""}`,
        5_000,
      );
    } else if (ev.event === "sprint_a_heartbeat") {
      // Sidebar reflects this through the status bar — a persistent dot in
      // the sidebar would be nicer but the status bar is the only spot
      // already wired and visible across all VS Code views.
      const d = ev.data as { agent?: string; elapsed_s?: number };
      const mins = Math.floor((d.elapsed_s ?? 0) / 60);
      const secs = (d.elapsed_s ?? 0) % 60;
      const elapsed = `${mins}:${String(secs).padStart(2, "0")}`;
      vscode.window.setStatusBarMessage(
        `Mission Control: ${d.agent ?? "agent"} — ${elapsed} elapsed…`,
        25_000, // a touch longer than the 20s heartbeat interval
      );
    } else if (ev.event === "build_heartbeat") {
      // Per-task Sprint B heartbeat (Phase B audit fix #5). Status bar
      // shows the current task title + elapsed; with agents>1 multiple
      // tasks heartbeat, so we just show whichever fired last — a proper
      // dashboard webview is the longer-term answer.
      const d = ev.data as {
        task_id?: string;
        title?: string;
        tmux?: string;
        elapsed_s?: number;
      };
      const mins = Math.floor((d.elapsed_s ?? 0) / 60);
      const secs = (d.elapsed_s ?? 0) % 60;
      vscode.window.setStatusBarMessage(
        `Mission Control: build '${d.title ?? d.task_id ?? "?"}' — ${mins}:${String(secs).padStart(2, "0")} ($ tmux attach -t ${d.tmux ?? "?"})`,
        25_000,
      );
    } else if (ev.event === "merge_blocked") {
      const d = ev.data as { task_id?: string; info?: string };
      vscode.window.showWarningMessage(
        `Mission Control: merge blocked — task ${d.task_id} (${d.info ?? "conflict"})`,
      );
    } else if (ev.event === "off_limits_warning") {
      const d = ev.data as { pattern?: string; reason?: string };
      vscode.window.showWarningMessage(
        `Mission Control: off_limits pattern '${d.pattern}' may be a typo (${d.reason})`,
      );
    } else if (ev.event === "ideation_failed" || ev.event === "research_failed") {
      const d = ev.data as { reason?: string };
      const which = ev.event === "ideation_failed" ? "Ideation" : "Research";
      vscode.window.showWarningMessage(
        `Mission Control: ${which} produced no result — ${d.reason ?? "unknown"}. ` +
          `Sprint A is incomplete; use Mission Control: Start to retry.`,
      );
    } else if (ev.event === "sprint_done") {
      const d = ev.data as { type?: string; prs?: unknown[] };
      vscode.window.showInformationMessage(
        `Mission Control: Sprint ${d.type ?? ""} done (${d.prs?.length ?? 0} PRs)`,
      );
    } else if (ev.event === "budget_exceeded") {
      const d = ev.data as { spent_usd?: number; cap_usd?: number };
      const spent = d.spent_usd?.toFixed(4) ?? "?";
      const cap = d.cap_usd?.toFixed(2) ?? "?";
      vscode.window
        .showWarningMessage(
          `Mission Control: budget exceeded — $${spent} / $${cap}.`,
          "Raise cap",
          "Resume anyway",
          "View budget",
        )
        .then(async (pick) => {
          try {
            const { api } = await import("./api");
            if (pick === "Raise cap") {
              const input = await vscode.window.showInputBox({
                title: "New budget cap (USD)",
                value: String((d.cap_usd ?? 0) * 2 || 50),
                prompt: "Enter the new budget cap. Sprint will resume once raised.",
                validateInput: (v) =>
                  isFinite(parseFloat(v)) && parseFloat(v) > 0
                    ? null
                    : "must be a positive number",
              });
              if (!input) return;
              const cap_usd = parseFloat(input);
              await api("/budget", {
                method: "POST",
                body: JSON.stringify({ cap_usd }),
              });
              // Cap raised — resume automatically.
              await api("/sprint/resume", { method: "POST" });
              vscode.window.showInformationMessage(
                `Mission Control: cap raised to $${cap_usd} + resumed`,
              );
            } else if (pick === "Resume anyway") {
              await api("/sprint/resume", { method: "POST" });
              vscode.window.showInformationMessage(
                "Mission Control: resumed (cap unchanged)",
              );
            } else if (pick === "View budget") {
              await vscode.commands.executeCommand("missioncontrol.budget");
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Mission Control: ${msg}`);
          }
        });
    } else if (ev.event === "sprint_paused") {
      vscode.window.showInformationMessage("Mission Control: Sprint paused ⏸");
    } else if (ev.event === "skill_proposed") {
      // Auto-author was a foot-gun (planning/ideation could silently write
      // skills/*.md and embed cross-project). Now: staged → user approves
      // via this toast. Calls POST /skills/pending/{id}/{approve,reject}.
      const d = ev.data as {
        pending_id?: string;
        name?: string;
        description?: string;
        source?: string;
      };
      if (!d.pending_id || !d.name) return;
      const msg =
        `Mission Control: ${d.source ?? "agent"} proposed a new skill ` +
        `'${d.name}' — ${(d.description ?? "").slice(0, 100)}…`;
      vscode.window
        .showInformationMessage(msg, "Approve", "Reject", "View")
        .then(async (pick) => {
          const path = `/skills/pending/${d.pending_id}`;
          try {
            if (pick === "Approve") {
              const { api } = await import("./api");
              await api(`${path}/approve`, { method: "POST" });
              vscode.window.showInformationMessage(
                `Mission Control: approved skill '${d.name}'`,
              );
            } else if (pick === "Reject") {
              const { api } = await import("./api");
              await api(`${path}/reject`, { method: "POST" });
            } else if (pick === "View") {
              // Re-show as modal with full description.
              vscode.window.showInformationMessage(
                `Skill '${d.name}'\n\n${d.description ?? ""}\n\n` +
                  "Use the Approve/Reject buttons on the next notification.",
                { modal: true },
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `Mission Control: skill action failed — ${msg}`,
            );
          }
        });
    } else if (ev.event === "sprint_error") {
      const d = ev.data as { sprint_type?: string; message?: string };
      const sprint = d.sprint_type === "b" ? "Sprint B" : "Sprint A";
      vscode.window
        .showErrorMessage(
          `Mission Control: ${sprint} failed — ${d.message ?? "unknown error"}`,
          "Retry",
          "Show logs",
        )
        .then((pick) => {
          if (pick === "Retry") {
            // Sprint A re-trigger via /research; Sprint B has no single re-run.
            void vscode.commands.executeCommand(
              d.sprint_type === "b" ? "missioncontrol.approve" : "missioncontrol.start",
            );
          } else if (pick === "Show logs") {
            // Surface backend logs — user can scroll the pm2 stream.
            void vscode.commands.executeCommand("workbench.action.terminal.new");
          }
        });
    }
  });
  ws.start();
  context.subscriptions.push(ws);

  // Frontend-only build: no backend to replay open PRs from on activate.
  // (The WS handler wired above is also inert — WSClient.start() is a no-op
  // stub, so none of its events ever fire.)
}

export function deactivate() {}
