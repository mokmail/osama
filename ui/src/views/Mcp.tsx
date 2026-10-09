import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { agentApi } from "../lib/api";
import type { McpServerStatus } from "../lib/types";
import { McpPanel } from "../components/McpPanel";
import { Badge, Button, Card, CardHead } from "../components/ui";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

/**
 * The MCP view: a full page for connecting Osama to Model Context Protocol
 * servers. The chat sidebar has a compact modal with the same manager; this page
 * is the roomier surface, with a summary header and a pointer back to the chat
 * where the tools are actually used.
 */
export function McpView({ bus, onNavigate }: { bus: EventBus; onNavigate: (v: ViewId) => void }) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [toolCount, setToolCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      agentApi.mcpServers().then((r) => { if (alive) setServers(r.servers); }).catch(() => {});
      agentApi.mcpTools().then((r) => { if (alive) setToolCount(r.tools.length); }).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 5000);
    // A change made in the sidebar modal (or anywhere) refreshes this page at once.
    const onChange = () => pull();
    window.addEventListener("osama:mcp-changed", onChange);
    return () => { alive = false; clearInterval(t); window.removeEventListener("osama:mcp-changed", onChange); };
  }, []);

  // A server event over the bus refreshes the summary header immediately.
  useEffect(() => {
    const lastMcp = bus.last("mcp");
    if (!lastMcp) return;
    agentApi.mcpServers().then((r) => setServers(r.servers)).catch(() => {});
    agentApi.mcpTools().then((r) => setToolCount(r.tools.length)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length]);

  const connected = servers.filter((s) => s.connected).length;
  const trusted = servers.filter((s) => s.config.trusted).length;

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead
          title="MCP servers"
          sub="Model Context Protocol — bring your own tools, filesystems, and services into the agent."
          right={
            <div className="row" style={{ gap: 8 }}>
              <Badge kind={connected > 0 ? "ok" : ""}>{connected}/{servers.length} connected</Badge>
              {toolCount > 0 && <Badge kind="accent">{toolCount} tool{toolCount === 1 ? "" : "s"}</Badge>}
              {trusted > 0 && <Badge kind="warn">{trusted} trusted</Badge>}
            </div>
          }
        />
        <div className="row wrap" style={{ gap: 10, marginTop: 4 }}>
          <span className="small faint" style={{ flex: 1, minWidth: 240 }}>
            Tools from connected servers appear in the chat while <b>Agent mode</b> is on. Untrusted
            servers prompt before each call; trusted ones run automatically.
          </span>
          <Button size="sm" variant="ghost" onClick={() => onNavigate("chat")}>
            Use tools in chat <ArrowRight size={13} />
          </Button>
        </div>
      </Card>

      <Card className="card-pad">
        <McpPanel />
      </Card>
    </div>
  );
}
