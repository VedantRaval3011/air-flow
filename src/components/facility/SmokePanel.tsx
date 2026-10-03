'use client';

import { Sink } from '@/lib/facility/smoke';
import { SMOKE_STEPS, SmokeStats } from './SmokeTest3D';

/**
 * Side panel for a smoke study: the sequence of the test with the current
 * step marked, and live counts of where the smoke has gone.
 */
export default function SmokePanel({
  roomName,
  stats,
  preparing,
  staleAirflow,
  sinks,
  speed,
  onSpeed,
  onRestart,
  onStop,
  onEndNow,
}: {
  roomName: string;
  stats: SmokeStats | null;
  /** Room CFD still running: progress 0–100 */
  preparing: { progress: number; message: string } | null;
  /** The airflow shown was computed for an earlier door / damper state */
  staleAirflow: boolean;
  sinks: Sink[];
  speed: number;
  onSpeed: (v: number) => void;
  onRestart: () => void;
  onStop: () => void;
  onEndNow: () => void;
}) {
  const step = stats?.step ?? -1;
  const captured = stats?.smokeCaptured ?? 0;
  const released = stats?.smokeReleased ?? 0;
  const pct = (n: number) => (released > 0 ? `${Math.round((100 * n) / released)} %` : '—');

  const bySink = sinks
    .map((s) => ({ s, n: stats?.capturedBySink[s.id] ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const viaDoors = bySink.filter((x) => x.s.kind === 'door').reduce((a, x) => a + x.n, 0);

  return (
    <div className="w-80 rounded-xl border border-slate-700 bg-slate-950/95 p-3 text-[12px] shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            Smoke test{stats ? ` · ${formatTime(stats.t)} elapsed` : ''}
          </div>
          <div className="text-sm font-semibold text-white">{roomName}</div>
        </div>
        <button onClick={onStop} aria-label="Stop smoke test" className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-base text-slate-200 hover:bg-slate-700">
          ×
        </button>
      </div>

      {preparing ? (
        <div className="mb-2 rounded-md bg-slate-900 p-2">
          <div className="mb-1 text-slate-300">Computing this room&apos;s airflow for the test…</div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div className="h-full bg-slate-300 transition-all" style={{ width: `${preparing.progress}%` }} />
          </div>
          <div className="mt-1 truncate text-[10px] text-slate-500">{preparing.message}</div>
        </div>
      ) : (
        <>
          {stats && !stats.done && (
            <div className="mb-3">
              <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                <span>
                  Smoke cleared {Math.round(stats.outFraction * 100)} % <span className="text-slate-600">/ test ends at 95 %</span>
                </span>
                <span>
                  {!stats.releaseEnded
                    ? 'releasing…'
                    : stats.eta !== null
                      ? `≈ ${formatTime(stats.eta / Math.max(1, speed))} left`
                      : 'estimating…'}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-slate-800">
                <div className="h-full bg-slate-300 transition-all" style={{ width: `${Math.min(100, (stats.outFraction / 0.95) * 100)}%` }} />
              </div>
            </div>
          )}
          {stats?.done && stats.stoppedEarly && (
            <div className="mb-3 rounded-md border border-slate-600 bg-slate-900 p-2 text-[11px] text-slate-300">
              <div className="font-semibold text-white">Test ended — {formatTime(stats.t)}</div>
              Stopped with {Math.round(stats.outFraction * 100)} % of the smoke cleared
              {viaDoors > 0 ? `, ${Math.round((100 * viaDoors) / Math.max(1, captured))} % of that through door gaps.` : ', all through the room\u2019s own risers / grilles.'}
            </div>
          )}
          {stats?.done && !stats.stoppedEarly && (
            <div className="mb-3 rounded-md border border-slate-600 bg-slate-900 p-2">
              <div className="font-semibold text-white">✓ Test complete — {formatTime(stats.t)}</div>
              {stats.clearance95 !== null ? (
                <div className="mt-1 space-y-1 text-[11px] leading-relaxed text-slate-300">
                  <div>
                    95 % of the smoke had left <b className="text-white">{formatTime(stats.clearance95)}</b> after the release
                    stopped
                    {viaDoors > 0
                      ? `, ${Math.round((100 * viaDoors) / Math.max(1, captured))} % of it through door gaps into the next room.`
                      : ', all of it through the room\u2019s own risers / grilles; none leaked through the doors.'}
                  </div>
                  {stats.recovery100 !== null && (
                    <div>
                      Estimated 100:1 recovery (ISO 14644-3): <b className="text-white">{formatTime(stats.recovery100)}</b>.
                    </div>
                  )}

                </div>
              ) : (
                <div className="mt-1 text-[11px] leading-relaxed text-slate-300">
                  Stopped at the 10-minute limit with {Math.round((100 * captured) / Math.max(1, released))} % of the smoke out;
                  the rest is circulating in slow corners of the room.
                </div>
              )}
            </div>
          )}
          <ol className="mb-3 space-y-1">
            {SMOKE_STEPS.map((label, i) => {
              // The last step stays "current" while smoke keeps leaving.
              const done = i < step;
              const current = i === step;
              return (
                <li key={label} className={`flex gap-2 ${current ? 'text-white' : done ? 'text-slate-300' : 'text-slate-500'}`}>
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${
                      current ? 'bg-slate-200 text-slate-900' : done ? 'bg-slate-600 text-white' : 'border border-slate-600'
                    }`}
                  >
                    {done && !current ? '✓' : i + 1}
                  </span>
                  <span>{label}</span>
                </li>
              );
            })}
          </ol>

          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <Figure label="Smoke released" value={released.toLocaleString()} unit="puffs" />
            <Figure label={stats?.done ? 'Left in the room at the end' : 'Still in the room'} value={(stats?.smokeInRoom ?? 0).toLocaleString()} />
            <Figure label="Out via risers / grilles" value={pct(captured - viaDoors)} />
            <Figure label="Out via door gaps" value={pct(viaDoors)} />
            <Figure label="Typical time to leave" value={stats?.medianTransit !== null && stats?.medianTransit !== undefined ? stats.medianTransit.toFixed(0) : '—'} unit="s" />
          </div>

          {bySink.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Where the smoke left</div>
              {bySink.slice(0, 6).map(({ s, n }) => (
                <div key={s.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-28 truncate text-slate-300">{s.label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
                    <div className="h-full bg-slate-400" style={{ width: `${(100 * n) / Math.max(1, captured)}%` }} />
                  </div>
                  <span className="w-9 text-right font-mono text-slate-400">{Math.round((100 * n) / Math.max(1, captured))}%</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {staleAirflow && !preparing && (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px] text-amber-200">
          Doors or dampers have changed since this airflow was computed. Restart to recompute.
        </div>
      )}

      <div className="flex items-center gap-1 text-[11px]">
        <span className="mr-1 text-slate-500">Speed</span>
        {[1, 2, 4].map((v) => (
          <button
            key={v}
            onClick={() => onSpeed(v)}
            className={`rounded px-2 py-0.5 ${speed === v ? 'bg-slate-200 text-slate-900' : 'bg-slate-800 text-slate-300'}`}
          >
            {v}×
          </button>
        ))}
        <span className="ml-auto flex gap-1">
          {stats && !stats.done && (
            <button onClick={onEndNow} className="rounded bg-slate-800 px-2 py-0.5 text-slate-200 hover:bg-slate-700">
              End test now
            </button>
          )}
          <button onClick={onRestart} className="rounded bg-slate-800 px-2 py-0.5 text-slate-200 hover:bg-slate-700">
            {stats?.done ? 'Run again' : 'Restart'}
          </button>
          {stats?.done && (
            <button onClick={onStop} className="rounded bg-slate-200 px-2 py-0.5 font-semibold text-slate-900 hover:bg-white">
              Close
            </button>
          )}
        </span>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        The operator releases smoke for about 14 s; the test is complete when 95 % of it has left through the room&apos;s suction
        (or after 10 minutes of test time). It starts at 4× so it takes a minute or two; 1× is real time. Smoke is carried by this room&apos;s CFD airflow (time-averaged, mass-conserving) and spread by
        turbulent mixing; glycol test smoke is treated as neutrally buoyant, and heat plumes are not modelled.
      </p>
    </div>
  );
}

function Figure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-md bg-slate-900 px-2 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="font-mono text-[13px] text-slate-100">
        {value}
        {unit && <span className="ml-1 text-[10px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
