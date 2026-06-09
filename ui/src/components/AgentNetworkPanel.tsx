import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { Activity, Network } from "lucide-react";
import { t } from "@/i18n";

// ── Layout constants (compact, banner-friendly) ─────────────────────────
const NODE_W = 152;
const NODE_H = 58;
const GAP_X = 26;
const GAP_Y = 52;
const PADDING = 28;
const PANEL_MIN_H = 200;
const PANEL_MAX_H = 340;
const MAX_SCALE = 1.15;

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

// ── Tree layout (mirrors OrgChart, tuned for the dashboard banner) ───────

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return NODE_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(NODE_W, childrenW + gaps);
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;
    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + NODE_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    x: x + (totalW - NODE_W) / 2,
    y,
    children: layoutChildren,
  };
}

function layoutForest(roots: OrgNode[]): LayoutNode[] {
  let x = PADDING;
  const y = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    result.push(layoutTree(root, x, y));
    x += subtreeWidth(root) + GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  const walk = (n: LayoutNode) => {
    result.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return result;
}

function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  const walk = (n: LayoutNode) => {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  };
  nodes.forEach(walk);
  return edges;
}

// ── Status colors (raw hex for SVG / inline style) ───────────────────────

const statusColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  pending_approval: "#fbbf24",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const DEFAULT_COLOR = "#a3a3a3";

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

// ── Component ─────────────────────────────────────────────────────────────

export function AgentNetworkPanel({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(companyId),
    queryFn: () => agentsApi.org(companyId),
    enabled: !!companyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "agent-network"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: 0, limit: 50 }),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: !!companyId,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  const issueIdentifier = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of issues ?? []) m.set(i.id, i.identifier ?? i.id.slice(0, 8));
    return m;
  }, [issues]);

  // Most recent active run per agent — drives the "live + executing" state.
  const activeRunByAgent = useMemo(() => {
    const m = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns ?? []) {
      if (!isRunActive(run)) continue;
      const existing = m.get(run.agentId);
      if (!existing || new Date(run.createdAt) > new Date(existing.createdAt)) {
        m.set(run.agentId, run);
      }
    }
    return m;
  }, [liveRuns]);

  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 600, height: 240 };
    let maxX = 0;
    let maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Fit-to-width scaling driven by a ResizeObserver on the viewport.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setViewportWidth(width);
    });
    observer.observe(el);
    setViewportWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (viewportWidth === 0 || bounds.width === 0) return 1;
    const widthScale = viewportWidth / bounds.width;
    const heightScale = PANEL_MAX_H / bounds.height;
    return Math.min(widthScale, heightScale, MAX_SCALE);
  }, [viewportWidth, bounds]);

  const scaledWidth = bounds.width * scale;
  const scaledHeight = bounds.height * scale;
  const panelHeight = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, scaledHeight));
  const offsetX = Math.max(0, (viewportWidth - scaledWidth) / 2);
  const offsetY = Math.max(0, (panelHeight - scaledHeight) / 2);

  if (orgTree && orgTree.length === 0) return null;

  const activeCount = activeRunByAgent.size;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Network className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("dashboard.agentNetwork")}
          </h3>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {activeCount > 0 ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-500" />
              </span>
              <span className="tabular-nums">
                {t("dashboard.agentsExecuting", { count: activeCount })}
              </span>
            </>
          ) : (
            <>
              <Activity className="h-3.5 w-3.5" />
              <span>{t("dashboard.networkIdle")}</span>
            </>
          )}
        </div>
      </div>

      {/* Network viewport */}
      <div
        ref={viewportRef}
        className="relative w-full overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--border)_1px,transparent_0)] [background-size:22px_22px]"
        style={{ height: panelHeight }}
      >
        {/* Edge layer */}
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={scaledWidth}
          height={scaledHeight}
          style={{ left: offsetX, top: offsetY }}
          viewBox={`0 0 ${bounds.width} ${bounds.height}`}
        >
          {edges.map(({ parent, child }) => {
            const x1 = parent.x + NODE_W / 2;
            const y1 = parent.y + NODE_H;
            const x2 = child.x + NODE_W / 2;
            const y2 = child.y;
            const midY = (y1 + y2) / 2;
            const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
            // An edge is "live" when either endpoint is actively executing.
            const live =
              activeRunByAgent.has(parent.id) || activeRunByAgent.has(child.id);
            const key = `${parent.id}-${child.id}`;
            return (
              <g key={key}>
                <path d={d} fill="none" stroke="var(--border)" strokeWidth={1.5} />
                {live && !reducedMotion && (
                  <path
                    className="agent-net-edge-flow"
                    d={d}
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    strokeLinecap="round"
                    opacity={0.9}
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* Node layer */}
        <div
          className="absolute left-0 top-0"
          style={{
            width: bounds.width,
            height: bounds.height,
            transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node, index) => {
            const agent = agentMap.get(node.id);
            const activeRun = activeRunByAgent.get(node.id);
            const isActive = Boolean(activeRun);
            const effectiveStatus = isActive ? "running" : node.status;
            const color = statusColor[effectiveStatus] ?? DEFAULT_COLOR;
            const taskLabel = activeRun?.issueId
              ? issueIdentifier.get(activeRun.issueId) ?? activeRun.issueId.slice(0, 8)
              : null;

            return (
              <button
                key={node.id}
                type="button"
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                title={`${node.name} — ${agent?.title ?? roleLabels[node.role] ?? node.role}`}
                className={cn(
                  "agent-net-node-enter absolute flex items-center gap-2 rounded-lg border bg-background/80 px-2.5 text-left backdrop-blur-sm transition-colors",
                  "hover:border-foreground/30 hover:bg-accent/40",
                  isActive
                    ? "border-cyan-500/40 bg-cyan-500/[0.06] agent-net-glow"
                    : "border-border",
                )}
                style={{
                  left: node.x,
                  top: node.y,
                  width: NODE_W,
                  height: NODE_H,
                  animationDelay: `${Math.min(index * 40, 400)}ms`,
                  ...(isActive
                    ? ({ "--agent-net-accent": color } as React.CSSProperties)
                    : {}),
                }}
              >
                {/* Live task chip */}
                {isActive && (
                  <span className="agent-net-task-chip absolute -top-2.5 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full border border-cyan-500/40 bg-card px-1.5 py-0.5 text-[9px] font-medium text-cyan-700 shadow-sm dark:text-cyan-300">
                    <span className="relative flex h-1.5 w-1.5 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-500" />
                    </span>
                    <span className="truncate">{taskLabel ?? t("dashboard.working")}</span>
                  </span>
                )}

                {/* Avatar + status dot */}
                <span className="relative shrink-0">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                    <AgentIcon icon={agent?.icon} className="h-4 w-4 text-foreground/70" />
                  </span>
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background"
                    style={{ backgroundColor: color }}
                  />
                </span>

                {/* Name + role */}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs font-semibold leading-tight text-foreground">
                    {node.name}
                  </span>
                  <span className="truncate text-[10px] leading-tight text-muted-foreground">
                    {agent?.title ?? roleLabels[node.role] ?? node.role}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
