'use client';

import { useState } from 'react';
import { Facility } from '@/lib/facility/types';
import { NetworkState } from '@/lib/facility/network';

type Verdict = 'pass' | 'warn' | 'fail' | 'info';

interface Cell {
  text: string;
  verdict: Verdict;
  why?: string;
}

/** Acceptance limits used for the pass / warn / fail marks. */
const LIMITS = {
  hepaFaceVelocity: [0.36, 0.54], // 0.45 m/s ± 20 %
  hepaDpWarn: 300,
  hepaDpFail: 450, // change-out is typically ~2× initial (≈ 450–500 Pa)
  damperMin: 10,
  damperMax: 95,
  riserVelocityWarn: 2.0,
  riserVelocityFail: 3.0,
  flowTolerance: 0.1,
  vfdMin: 25,
  vfdMax: 50,
};

const cell = (text: string | number, verdict: Verdict = 'info', why?: string): Cell => ({ text: String(text), verdict, why });

function damperCell(pct: number | null): Cell {
  if (pct === null) return cell('—');
  const v = `${pct.toFixed(0)} %`;
  if (pct < LIMITS.damperMin) return cell(v, 'warn', 'Nearly shut: little authority left, noisy');
  if (pct > LIMITS.damperMax) return cell(v, 'warn', 'Fully open: cannot add more flow');
  return cell(v, 'pass');
}

function flowCell(actual: number, design: number): Cell {
  if (design <= 0) return cell(actual);
  const err = (actual - design) / design;
  const v = `${actual} / ${Math.round(design)}`;
  return Math.abs(err) <= LIMITS.flowTolerance ? cell(v, 'pass') : cell(v, 'fail', `${(err * 100).toFixed(0)} % from design`);
}

export default function HvacCheck({
  facility,
  network,
  onClose,
}: {
  facility: Facility;
  network: NetworkState;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'rooms' | 'ahus'>('rooms');

  const roomHeader = [
    'Room', 'AHU', 'Pressure Pa (design)', 'Supply CFM (design)', 'Supply damper open', 'Supply main static Pa',
    'Damper ΔP Pa', 'HEPA plenum static Pa', 'HEPA terminal ΔP Pa', 'HEPA face vel. m/s', 'Riser damper open',
    'Riser CFM each', 'Riser face vel. m/s', 'Return CFM',
  ];
  const roomRows: Cell[][] = network.rooms.map((r) => {
    const room = facility.rooms.find((x) => x.id === r.roomId)!;
    const pressure =
      r.designPa === null
        ? cell(`${r.pressurePa.toFixed(1)}`)
        : cell(`${r.pressurePa.toFixed(1)} (${r.designPa})`, r.alarm === 'ok' ? 'pass' : 'fail', r.alarm === 'ok' ? undefined : `Pressure ${r.alarm}`);
    const h = r.hepa;
    const hepaDp = h
      ? cell(h.filterDpPa.toFixed(0), h.filterDpPa > LIMITS.hepaDpFail ? 'fail' : h.filterDpPa > LIMITS.hepaDpWarn ? 'warn' : 'pass', h.filterDpPa > LIMITS.hepaDpFail ? 'At change-out resistance' : undefined)
      : cell('—');
    const faceV = h
      ? cell(h.faceVelocity.toFixed(2), h.faceVelocity < LIMITS.hepaFaceVelocity[0] || h.faceVelocity > LIMITS.hepaFaceVelocity[1] ? 'warn' : 'pass', 'Target 0.45 m/s ± 20 %')
      : cell('—');
    const rv = r.riser
      ? cell(r.riser.faceVelocity.toFixed(2), r.riser.faceVelocity > LIMITS.riserVelocityFail ? 'fail' : r.riser.faceVelocity > LIMITS.riserVelocityWarn ? 'warn' : 'pass', 'Riser grilles ≤ 2 m/s to avoid draught and noise')
      : cell('—');
    return [
      cell(room.shortName),
      cell(room.hvac.ahu),
      pressure,
      r.supplyCfm > 0 || room.hvac.supplyCfm > 0 ? flowCell(r.supplyCfm, room.hvac.supplyCfm) : cell(r.exhaustCfm ? `exhaust ${r.exhaustCfm}` : '—'),
      damperCell(r.supplyDamperPct),
      cell(r.supplyBranch ? r.supplyBranch.mainStaticPa.toFixed(0) : '—'),
      cell(r.supplyBranch ? r.supplyBranch.damperDpPa.toFixed(0) : '—'),
      cell(h ? h.plenumStaticPa.toFixed(0) : '—'),
      hepaDp,
      faceV,
      damperCell(r.returnDamperPct),
      cell(r.riser ? `${r.riser.count} × ${r.riser.cfmEach}` : '—'),
      rv,
      cell(r.returnCfm || '—'),
    ];
  });

  const ahuHeader = [
    'AHU', 'Status', 'VFD Hz', 'VFD speed', 'Motor rpm', 'Motor kW', 'Current A', 'Supply CFM (design)',
    'Return CFM', 'Fresh air CFM (RDS)', 'FA damper', 'Bleed CFM (RDS)', 'Bleed damper', 'Supply static Pa',
    'Return static Pa', 'Fan ΔP Pa', 'Filters + coil ΔP Pa', 'Mean HEPA ΔP Pa',
  ];
  const ahuRows: Cell[][] = network.ahus.map((a) => {
    const h = facility.airHandlers.find((x) => x.id === a.id)!;
    const isAhu = a.kind === 'ahu';
    const hz = !a.running
      ? cell('0', 'fail', 'Stopped')
      : a.hz > LIMITS.vfdMax
        ? cell(a.hz, 'fail', 'Above 50 Hz: motor over base speed')
        : a.hz < LIMITS.vfdMin
          ? cell(a.hz, 'warn', 'Low speed: check motor cooling')
          : cell(a.hz, 'pass');
    const fa = isAhu
      ? cell(`${a.freshAirCfm} (${Math.round(h.freshAirCfm)})`, a.freshAirCfm < h.freshAirCfm * 0.9 ? 'warn' : 'pass', a.freshAirCfm < h.freshAirCfm * 0.9 ? 'Below the RDS fresh-air quantity' : undefined)
      : cell('—');
    return [
      cell(a.id),
      cell(a.running ? 'Running' : 'Stopped', a.running ? 'pass' : 'fail'),
      hz,
      cell(`${a.vfdSpeedPct} %`),
      cell(a.motorRpm),
      cell(a.motorKw.toFixed(2)),
      cell(a.motorCurrentA.toFixed(1)),
      isAhu ? flowCell(a.supplyCfm, a.designSupplyCfm) : cell('—'),
      cell(a.returnCfm),
      fa,
      cell(isAhu ? `${a.freshAirPct.toFixed(0)} %` : '—'),
      cell(isAhu ? `${a.bleedCfm} (${Math.round(h.bleedCfm)})` : '—'),
      cell(isAhu ? `${a.bleedPct.toFixed(0)} %` : '—'),
      cell(isAhu ? a.supplyStaticPa.toFixed(0) : '—'),
      cell(isAhu ? a.returnStaticPa.toFixed(0) : '—'),
      cell(a.fanDpPa.toFixed(0)),
      cell(isAhu ? a.internalDpPa.toFixed(0) : '—'),
      a.hepaFilterDpPa === null
        ? cell('—')
        : cell(a.hepaFilterDpPa.toFixed(0), a.hepaFilterDpPa > LIMITS.hepaDpFail ? 'fail' : a.hepaFilterDpPa > LIMITS.hepaDpWarn ? 'warn' : 'pass'),
    ];
  });

  const header = tab === 'rooms' ? roomHeader : ahuHeader;
  const rows = tab === 'rooms' ? roomRows : ahuRows;
  const all = [...roomRows, ...ahuRows].flat();
  const count = (v: Verdict) => all.filter((c) => c.verdict === v).length;

  function exportCsv() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      'Room terminals',
      roomHeader.map(esc).join(','),
      ...roomRows.map((r) => r.map((c) => esc(c.text)).join(',')),
      '',
      'Air handling units',
      ahuHeader.map(esc).join(','),
      ...ahuRows.map((r) => r.map((c) => esc(c.text)).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${facility.id}-hvac-check.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const tone: Record<Verdict, string> = {
    pass: 'text-emerald-300',
    warn: 'text-amber-300 bg-amber-500/10',
    fail: 'text-red-300 bg-red-500/10',
    info: 'text-slate-200',
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-[1500px] flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 border-b border-slate-800 px-5 py-3">
          <div>
            <div className="text-base font-semibold text-white">HVAC check</div>
            <div className="text-[11px] text-slate-400">
              Live values from the pressure network for the current door, damper and VFD settings
            </div>
          </div>
          <div className="flex gap-2 text-[11px]">
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">{count('pass')} pass</span>
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">{count('warn')} warn</span>
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-red-300">{count('fail')} fail</span>
          </div>
          <div className="ml-auto flex gap-2 text-[12px]">
            {(['rooms', 'ahus'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1 ${tab === t ? 'bg-cyan-500/20 text-cyan-200' : 'bg-slate-800 text-slate-400'}`}
              >
                {t === 'rooms' ? 'Rooms: dampers, HEPA, risers' : 'AHUs: VFD, fresh air, bleed'}
              </button>
            ))}
            <button onClick={exportCsv} className="rounded-md bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700">
              Export CSV
            </button>
            <button onClick={onClose} className="rounded-md bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700">
              Close
            </button>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-slate-900 text-slate-400">
              <tr>
                {header.map((h) => (
                  <th key={h} className="whitespace-nowrap border-b border-slate-800 px-2 py-2 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-800/70 hover:bg-slate-800/40">
                  {r.map((c, j) => (
                    <td key={j} title={c.why} className={`whitespace-nowrap px-2 py-1.5 font-mono ${j === 0 ? 'font-sans text-slate-100' : tone[c.verdict]}`}>
                      {c.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-800 px-5 py-2 text-[10px] leading-relaxed text-slate-500">
          HEPA plenum static = static in the terminal box above the filter (vs outdoors); HEPA terminal ΔP = drop across the
          filter media. Supply main static is at the branch take-off, upstream of the balancing damper. Limits: HEPA face
          velocity 0.45 m/s ± 20 %; HEPA ΔP warn &gt; {LIMITS.hepaDpWarn} Pa, fail &gt; {LIMITS.hepaDpFail} Pa; dampers {LIMITS.damperMin}–{LIMITS.damperMax} %;
          risers ≤ {LIMITS.riserVelocityWarn} m/s; flows ± {LIMITS.flowTolerance * 100} % of design; VFD {LIMITS.vfdMin}–{LIMITS.vfdMax} Hz. Hover a
          flagged value for the reason.
        </div>
      </div>
    </div>
  );
}
