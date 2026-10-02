/**
 * The order the worker pools take jobs in: taking turns between sessions, not
 * first come first served.
 *
 * The pools are shared by every session, and on a CPU-only host a recording
 * takes longer to transcribe than it lasts. In arrival order, one group dropping
 * in twelve lectures would leave every other group waiting behind all twelve.
 * Here each session's k-th waiting job is ranked as if behind the jobs that
 * session already has in flight, so a session with nothing running goes next
 * whatever its arrival: one job from each session in turn, then the second
 * from each, and so on. Ties go to the session served longest ago, then the
 * older job: counting only what is in flight was not enough on a fast pool,
 * where a session's jobs finish before the next choice - with nothing in
 * flight it tied with a session never served at all, and won on age.
 *
 * Pure, and shared: the dispatcher uses it to choose what to send to a pool,
 * and the queue-position view uses it to say where a job stands, so the number
 * a person sees is the order the work really happens in.
 */

export interface WaitingJob {
  id: string;
  sessionId: string;
  createdAt: number;
}

/**
 * `waiting`: jobs of one pool not yet handed to it. `inFlight`: per session,
 * how many of its jobs that pool already has (handed over or running).
 */
export function fairOrder<T extends WaitingJob>(
  waiting: T[],
  inFlight: ReadonlyMap<string, number>,
  /** Per session: when the pool was last handed one of its jobs. Never = first. */
  lastServed: ReadonlyMap<string, number> = new Map(),
): T[] {
  const nth = new Map<string, number>();
  return [...waiting]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((job) => {
      const k = (nth.get(job.sessionId) ?? 0) + 1;
      nth.set(job.sessionId, k);
      return { job, turn: (inFlight.get(job.sessionId) ?? 0) + k };
    })
    .sort(
      (a, b) =>
        a.turn - b.turn ||
        (lastServed.get(a.job.sessionId) ?? 0) - (lastServed.get(b.job.sessionId) ?? 0) ||
        a.job.createdAt - b.job.createdAt ||
        a.job.id.localeCompare(b.job.id),
    )
    .map(({ job }) => job);
}
