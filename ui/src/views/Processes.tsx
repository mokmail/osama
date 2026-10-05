import { useEffect, useState } from "react";
import { Activity, Square, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { ManagedProcess } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Empty, StatusDot, usePoll, useToast } from "../components/ui";
import { duration } from "../lib/format";
import type { EventBus } from "../App";

export function ProcessesView({ bus }: { bus: EventBus }) {
  const toast = useToast();
  const [procs, setProcs] = useState<ManagedProcess[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string[]>>({});

  const load = () => api.processes().then((r) => setProcs(r.processes)).catch(() => {});
  usePoll(load, 3000);

  // accumulate per-process log lines from the event stream
  useEffect(() => {
    const last = bus.events[bus.events.length - 1];
    if (last?.type === "process" && last.data?.line) {
      setLogs((l) => ({ ...l, [last.data.id]: [...(l[last.data.id] ?? []).slice(-500), last.data.line] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length]);

  useEffect(() => {
    if (!selected && procs.length) setSelected(procs[0]!.id);
  }, [procs, selected]);

  const active = procs.find((p) => p.id === selected) ?? null;

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead title="Processes" sub="Every llama.cpp process Osama has launched. Long-running ones can be stopped here." />
        {procs.length === 0 ? (
          <Empty icon={<Activity size={28} />} title="No processes" sub="Start a server or a chat to see it here." />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {procs.map((p) => (
              <div
                key={p.id}
                className={`tile ${selected === p.id ? "active" : ""}`}
                style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
                onClick={() => setSelected(p.id)}
              >
                <StatusDot status={p.status} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 550, fontSize: 13 }}>{p.label}</span>
                    {p.url && <Badge kind="info">{p.url}</Badge>}
                  </div>
                  <div className="faint small mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    pid {p.pid} · {p.tool}
                  </div>
                </div>
                <div className="row" style={{ gap: 8, flex: "none" }}>
                  <span className="faint small">{new Date(p.startedAt).toLocaleTimeString()}</span>
                  {(p.status === "running" || p.status === "starting") && (
                    <Button size="sm" variant="danger" onClick={async (e?: any) => {
                      e?.stopPropagation?.();
                      await api.stopProcess(p.id);
                      toast.push("info", "Process stopped.");
                      load();
                    }}>
                      <Square size={12} /> Stop
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {active && (
        <Card className="card-pad">
          <CardHead
            title={`Log · ${active.label}`}
            sub={active.argv.join(" ")}
            right={
              <div className="row" style={{ gap: 8 }}>
                <Badge>exit {active.exitCode ?? "—"}</Badge>
                {active.endedAt && <Badge>{duration(active.endedAt - active.startedAt)}</Badge>}
                <Button size="sm" variant="ghost" onClick={() => setLogs((l) => ({ ...l, [active.id]: [] }))}>
                  <Trash2 size={13} /> Clear
                </Button>
              </div>
            }
          />
          <Console lines={logs[active.id] ?? (active.status === "running" ? ["waiting for output…"] : ["(no buffered output — see the log file)"])} />
          <div className="faint small" style={{ marginTop: 8 }}>Log file: {active.logPath}</div>
        </Card>
      )}
    </div>
  );
}
