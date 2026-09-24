import { useEffect, useState } from "react";
import type { MediaType } from "@rmcollab/shared";
import { api } from "../../api/client";

interface QueueDepth {
  mediaType: MediaType;
  queue: string;
  depth: number;
  workersOnline: boolean;
}

export interface Metrics {
  replicaId: string;
  queues: QueueDepth[];
  jobs: Record<string, number>;
  jobEventStreamLength: number;
  at: number;
}

const POLL_MS = 2000;

export function ClusterPanel() {
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every reply names the replica that served it. Behind the load balancer that
  // set grows as replicas are scaled up, which is the visible proof that the
  // gateway is genuinely horizontal rather than merely designed to be.
  const [replicas, setReplicas] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await api.metrics();
        if (cancelled) return;
        setMetrics(next);
        setError(null);
        setReplicas((seen) => (seen.includes(next.replicaId) ? seen : [...seen, next.replicaId]));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Metrics unavailable");
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  const totalQueued = metrics?.queues.reduce((sum, q) => sum + q.depth, 0) ?? 0;

  return (
    <div className={open ? "cluster is-open" : "cluster"}>
      <button
        type="button"
        className="cluster-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="cluster-panel"
      >
        <span aria-hidden="true">◍</span>
        <span>Cluster</span>
        {totalQueued > 0 && <span className="cluster-badge">{totalQueued}</span>}
      </button>

      <div className="cluster-panel" id="cluster-panel" hidden={!open}>
        <h2>Cluster</h2>
        {error && (
          <p className="error-text" role="alert">
            <span aria-hidden="true">✕</span>
            {error}
          </p>
        )}

        <dl className="cluster-stats">
          <div>
            <dt>Served by</dt>
            <dd>
              <code>{metrics?.replicaId ?? "…"}</code>
            </dd>
          </div>
          <div>
            <dt>Gateway replicas seen</dt>
            <dd>{replicas.length || "…"}</dd>
          </div>
          <div>
            <dt>Job events</dt>
            <dd>{metrics?.jobEventStreamLength ?? "…"}</dd>
          </div>
        </dl>

        <table className="cluster-queues">
          <caption className="visually-hidden">Queue depth and worker pool health</caption>
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">Depth</th>
              <th scope="col">Workers</th>
            </tr>
          </thead>
          <tbody>
            {(metrics?.queues ?? []).map((q) => (
              <tr key={q.queue}>
                <th scope="row">{q.mediaType}</th>
                <td>{q.depth}</td>
                <td>
                  <span className={q.workersOnline ? "dot-ok" : "dot-off"} aria-hidden="true" />
                  {q.workersOnline ? "online" : "offline"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="cluster-jobs">
          {(["queued", "processing", "done", "failed"] as const).map((status) => (
            <span key={status}>
              {status} <strong>{metrics?.jobs?.[status] ?? 0}</strong>
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
