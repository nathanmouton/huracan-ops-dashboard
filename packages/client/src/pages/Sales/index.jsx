import { useState, useEffect, useRef } from 'react';
import {
  BarChart, Bar, Cell,
  PieChart, Pie, Legend,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { getSalesKPIs, getSalesToday, getSalesAnnual, triggerSalesSync } from '../../api/index.js';
import styles from './index.module.css';

// ─── constants ────────────────────────────────────────────────────────────────

const REP_COLORS = {
  Martinez:  '#E8593C',
  Rodrigo:   '#3B82F6',
  Alejandro: '#10B981',
  Jacob:     '#F59E0B',
  Jahmad:    '#8B5CF6',
};

const LOCATION_GOALS = {
  Austin: 100000, Houston: 100000, 'Fort Worth': 100000,
  Roanoke: 100000, Frisco: 100000,
};

const WEEKLY_PACE_GOAL = Math.round(100000 / 4.3); // ≈ $23,256

const SOURCE_COLORS = ['#E8593C', '#f0a500', '#3ecf8e', '#4e9af1', '#a855f7', '#ec4899'];
const ORDINALS      = ['—', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const MONTHS        = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL_MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const POLL_MS       = 5 * 60 * 60 * 1000;

const C = { grid: '#252525', axis: '#555', ttBg: '#1e1e1e', ttBorder: '#333' };

// ─── helpers ──────────────────────────────────────────────────────────────────

const repColor = (name) => REP_COLORS[name] || '#888';
const fmtUSD   = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtNum   = new Intl.NumberFormat('en-US');
const fmtK     = (v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`;

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtWeek(start, end) {
  const s = new Date(start + 'T00:00:00');
  const e = end ? new Date(end + 'T00:00:00') : null;
  return `${MONTHS[s.getMonth()]} ${s.getDate()}${e ? ` – ${MONTHS[e.getMonth()]} ${e.getDate()}` : ''}`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return `${dt.getMonth() + 1}/${dt.getDate()}/${String(dt.getFullYear()).slice(2)}`;
}

// '2026-04' → 'April 2026'
function fmtMonthFull(m) {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  return `${FULL_MONTHS[parseInt(mo, 10) - 1]} ${y}`;
}

// '2026-04' → 'Apr'
function fmtMonthShort(m) {
  if (!m) return '';
  return MONTHS[parseInt(m.split('-')[1], 10) - 1] ?? m;
}

function groupByWeek(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.week_start)) {
      map.set(row.week_start, { week_start: row.week_start, week_end: row.week_end, reps: [] });
    }
    map.get(row.week_start).reps.push(row);
  }
  return [...map.values()];
}

function buildWeeklySparklines(raw, repNames, weekStart, weekEnd) {
  if (!weekStart || !weekEnd) return {};
  const spine = [];
  const s = new Date(weekStart + 'T00:00:00');
  const e = new Date(weekEnd   + 'T00:00:00');
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    spine.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  const result = {};
  for (const name of repNames) {
    const byDate = {};
    raw.filter(r => r.rep_name === name && spine.includes(r.close_date))
       .forEach(r => { byDate[r.close_date] = (byDate[r.close_date] || 0) + r.revenue; });
    result[name] = spine.map(date => ({ date, revenue: byDate[date] || 0 }));
  }
  return result;
}

// ─── tooltips ─────────────────────────────────────────────────────────────────

function Tt({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.ttBg, border: `1px solid ${C.ttBorder}`, borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#888', marginBottom: 4 }}>{label ?? payload[0].name}</div>
      <div style={{ color: '#fff', fontWeight: 600 }}>{fmtUSD.format(payload[0].value)}</div>
    </div>
  );
}

function PieTt({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.ttBg, border: `1px solid ${C.ttBorder}`, borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#888', marginBottom: 4 }}>{payload[0].name}</div>
      <div style={{ color: '#fff', fontWeight: 600 }}>{fmtUSD.format(payload[0].value)}</div>
      <div style={{ color: '#666', marginTop: 2 }}>{payload[0].payload.closes} closes</div>
    </div>
  );
}

// ─── shared micro ─────────────────────────────────────────────────────────────

function Sparkline({ data, color }) {
  if (!data?.length) return <div className={styles.sparklineWrap} />;
  return (
    <div className={styles.sparklineWrap}>
      <ResponsiveContainer width="100%" height={44}>
        <LineChart data={data}>
          <Line type="monotone" dataKey="revenue" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Reusable donut chart for lead sources
function LeadSourcesDonut({ leadSources }) {
  if (leadSources.length === 0) return <div className={styles.emptyChart}>No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={leadSources}
          dataKey="revenue"
          nameKey="lead_source"
          cx="50%" cy="45%"
          outerRadius={78} innerRadius={44}
          paddingAngle={3}
        >
          {leadSources.map((_, i) => (
            <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<PieTt />} />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
          formatter={(v) => <span style={{ color: '#888' }}>{v}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── ALWAYS-VISIBLE strip ─────────────────────────────────────────────────────

function SummaryStrip({ totals, weekTotals, todayTotals, selectedMonth }) {
  const monthName = fmtMonthShort(selectedMonth) || MONTHS[new Date().getMonth()];
  return (
    <div className={styles.summaryStrip}>
      <span className={styles.stripSegment}>
        <span className={styles.stripLabel}>{monthName}:</span>
        <span className={styles.stripValue}>{fmtUSD.format(totals.revenue ?? 0)}</span>
        <span className={styles.stripMuted}>· {totals.closes ?? 0} closes</span>
      </span>
      <span className={styles.stripDivider} />
      <span className={styles.stripSegment}>
        <span className={styles.stripLabel}>This week:</span>
        <span className={styles.stripValue}>{fmtUSD.format(weekTotals.revenue)}</span>
        <span className={styles.stripMuted}>· {weekTotals.closes} closes</span>
      </span>
      <span className={styles.stripDivider} />
      <span className={styles.stripSegment}>
        <span className={styles.stripLabel}>Today:</span>
        <span className={styles.stripValue}>{fmtUSD.format(todayTotals.revenue)}</span>
        <span className={styles.stripMuted}>· {todayTotals.closes} closes</span>
      </span>
    </div>
  );
}

// ─── MONTHLY components ───────────────────────────────────────────────────────

// 3 KPI cards — Team Goal Progress removed
function MonthlyKPIStrip({ totals }) {
  const avgDeal = (totals.closes ?? 0) > 0
    ? Math.round((totals.revenue ?? 0) / totals.closes)
    : 0;

  const cards = [
    { label: 'Total Revenue',  value: fmtUSD.format(totals.revenue ?? 0) },
    { label: 'Total Closes',   value: totals.closes ?? 0 },
    { label: 'Avg Deal Size',  value: fmtUSD.format(avgDeal) },
  ];

  return (
    <div className={styles.kpiStrip3}>
      {cards.map((c) => (
        <div key={c.label} className={styles.kpiCard}>
          <span className={styles.kpiLabel}>{c.label}</span>
          <span className={styles.kpiValue}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

// 2 spotlight cards — Most Activity removed
function SpotlightCards({ monthlyByRep }) {
  if (monthlyByRep.length === 0) return null;
  const byCloses = [...monthlyByRep].sort((a, b) => b.closes - a.closes)[0];
  const cards = [
    { icon: '🏆', label: 'Top Revenue',  rep: monthlyByRep[0], stat: fmtUSD.format(monthlyByRep[0].revenue) },
    { icon: '🎯', label: 'Most Closes',  rep: byCloses,         stat: `${byCloses.closes} closes` },
  ];
  return (
    <div className={styles.spotlightRow2}>
      {cards.map((c) => (
        <div key={c.label} className={styles.spotlightCard} style={{ '--rep-color': repColor(c.rep.rep_name) }}>
          <span className={styles.spotlightIcon}>{c.icon}</span>
          <div className={styles.spotlightInfo}>
            <span className={styles.spotlightLabel}>{c.label}</span>
            <span className={styles.spotlightName} style={{ color: repColor(c.rep.rep_name) }}>{c.rep.rep_name}</span>
            <span className={styles.spotlightStat}>{c.stat}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Leaderboard({ reps }) {
  if (reps.length === 0) return <div className={styles.emptyState}>No data for this month</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Rep</th>
            <th className={styles.num}>Revenue</th>
            <th className={styles.num}>Closes</th>
            <th className={styles.num}>Avg Deal</th>
            <th className={styles.num}>Dials</th>
            <th className={styles.num}>Texts</th>
            <th>Activity</th>
            <th>Goal %</th>
          </tr>
        </thead>
        <tbody>
          {reps.map((r, i) => {
            const avgDeal      = r.closes > 0 ? Math.round(r.revenue / r.closes) : 0;
            const color        = repColor(r.rep_name);
            const highActivity = r.dials > 100;
            const isTop        = i === 0;
            return (
              <tr key={r.rep_name} className={isTop ? styles.leaderRow : ''}>
                <td style={isTop
                  ? { boxShadow: `inset 3px 0 0 ${color}`, color: 'var(--text-muted)', fontSize: 12 }
                  : { color: 'var(--text-muted)', fontSize: 12 }}>
                  {ORDINALS[i+1] ?? `${i+1}th`}
                </td>
                <td><span className={styles.repDot} style={{ background: color }} />{r.rep_name}</td>
                <td className={styles.num}>{fmtUSD.format(r.revenue)}</td>
                <td className={styles.num}>{r.closes}</td>
                <td className={styles.num}>{fmtUSD.format(avgDeal)}</td>
                <td className={styles.num}>{fmtNum.format(r.dials)}</td>
                <td className={styles.num}>{fmtNum.format(r.texts)}</td>
                <td><span className={highActivity ? styles.actHigh : styles.actLow}>{highActivity ? 'High' : 'Low'}</span></td>
                <td className={styles.goalCell}>
                  <div className={styles.goalBarWrap}>
                    <div className={styles.goalBarTrack}>
                      <div className={styles.goalBarFill} style={{ width: `${r.goal_pct}%`, background: color }} />
                    </div>
                    <span className={styles.goalPct}>{r.goal_pct}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── WEEKLY components ────────────────────────────────────────────────────────

function WeeklyRepCard({ rep, weeklySparkline }) {
  const color   = repColor(rep.rep_name);
  const weekPct = Math.min(Math.round((rep.revenue / WEEKLY_PACE_GOAL) * 100), 100);
  return (
    <div className={styles.repCard} style={{ '--rep-color': color }}>
      <div className={styles.repCardHeader}>
        <span className={styles.repName}>{rep.rep_name}</span>
      </div>
      <div className={styles.repRevenue}>{fmtUSD.format(rep.revenue)}</div>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${weekPct}%`, background: color }} />
      </div>
      <div className={styles.progressLabel}>{weekPct}% of ${(WEEKLY_PACE_GOAL / 1000).toFixed(1)}k weekly pace</div>
      {rep.revenue >= WEEKLY_PACE_GOAL
        ? <div className={styles.goalReached}>✓ Pace reached</div>
        : <div className={styles.goalRemaining}>{fmtUSD.format(WEEKLY_PACE_GOAL - rep.revenue)} to pace</div>
      }
      <div className={styles.pills}>
        <span className={styles.pill}>{rep.closes} closes</span>
        <span className={styles.pill}>{fmtNum.format(rep.dials)} dials</span>
        <span className={styles.pill}>{fmtNum.format(rep.texts)} texts</span>
      </div>
      <Sparkline data={weeklySparkline} color={color} />
    </div>
  );
}

function WeekAccordion({ weekGroups, expandedWeeks, setExpandedWeeks, todayStr }) {
  function toggle(key) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  return (
    <div className={styles.weeklySection}>
      <p className={styles.sectionLabel}>All Weeks — This Month</p>
      {weekGroups.length === 0 && <div className={styles.emptyState}>No weekly data for this month</div>}
      {weekGroups.map((wk) => {
        const total = wk.reps.reduce(
          (acc, r) => ({ dials: acc.dials+r.dials, texts: acc.texts+r.texts, closes: acc.closes+r.closes, revenue: acc.revenue+r.revenue }),
          { dials: 0, texts: 0, closes: 0, revenue: 0 }
        );
        const open   = expandedWeeks.has(wk.week_start);
        const isCurr = todayStr >= wk.week_start && todayStr <= wk.week_end;
        return (
          <div key={wk.week_start} className={`${styles.weekItem} ${isCurr ? styles.weekItemCurrent : ''}`}>
            <div className={styles.weekHeader} onClick={() => toggle(wk.week_start)} role="button">
              <span className={styles.weekLabel}>
                {fmtWeek(wk.week_start, wk.week_end)}
                {isCurr && <span className={styles.currentBadge}>Current week</span>}
              </span>
              <span className={styles.weekTotals}>
                <span className={styles.weekTotalItem}><strong>{fmtUSD.format(total.revenue)}</strong> rev</span>
                <span className={styles.weekTotalItem}><strong>{total.closes}</strong> closes</span>
                <span className={styles.weekTotalItem}><strong>{fmtNum.format(total.dials)}</strong> dials</span>
              </span>
              <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>▶</span>
            </div>
            {open && (
              <div className={styles.weekBody}>
                <table className={styles.weekTable}>
                  <thead>
                    <tr>
                      <th>Rep</th>
                      <th className={styles.num}>Dials</th>
                      <th className={styles.num}>Texts</th>
                      <th className={styles.num}>Closes</th>
                      <th className={styles.num}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wk.reps.map((r) => (
                      <tr key={r.rep_name}>
                        <td><span className={styles.repDot} style={{ background: repColor(r.rep_name) }} />{r.rep_name}</td>
                        <td className={styles.num}>{fmtNum.format(r.dials)}</td>
                        <td className={styles.num}>{fmtNum.format(r.texts)}</td>
                        <td className={styles.num}>{r.closes}</td>
                        <td className={styles.num}>{fmtUSD.format(r.revenue)}</td>
                      </tr>
                    ))}
                    <tr className={styles.totalRow}>
                      <td>Week Total</td>
                      <td className={styles.num}>{fmtNum.format(total.dials)}</td>
                      <td className={styles.num}>{fmtNum.format(total.texts)}</td>
                      <td className={styles.num}>{total.closes}</td>
                      <td className={styles.num}>{fmtUSD.format(total.revenue)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── ANNUAL components ────────────────────────────────────────────────────────

function AnnualKPIStrip({ annualData }) {
  const totals   = annualData?.totals ?? {};
  const breakdown = annualData?.monthly_breakdown ?? [];

  const avgDeal = (totals.closes ?? 0) > 0
    ? Math.round((totals.revenue ?? 0) / totals.closes)
    : 0;

  const bestMonth = breakdown.length > 0
    ? [...breakdown].sort((a, b) => b.revenue - a.revenue)[0]
    : null;

  const cards = [
    { label: 'YTD Revenue',  value: fmtUSD.format(totals.revenue ?? 0) },
    { label: 'YTD Closes',   value: totals.closes ?? 0 },
    { label: 'Avg Deal Size', value: avgDeal > 0 ? fmtUSD.format(avgDeal) : '—' },
    {
      label: 'Best Month',
      value: bestMonth ? fmtMonthShort(bestMonth.month) : '—',
      sub:   bestMonth ? fmtUSD.format(bestMonth.revenue) : null,
    },
  ];

  return (
    <div className={styles.kpiStrip}>
      {cards.map((c) => (
        <div key={c.label} className={styles.kpiCard}>
          <span className={styles.kpiLabel}>{c.label}</span>
          <span className={styles.kpiValue}>{c.value}</span>
          {c.sub && <span className={styles.kpiSub}>{c.sub}</span>}
        </div>
      ))}
    </div>
  );
}

function AnnualLeaderboard({ byRep }) {
  if (!byRep || byRep.length === 0) return <div className={styles.emptyState}>No annual data available</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Rep</th>
            <th className={styles.num}>YTD Revenue</th>
            <th className={styles.num}>YTD Closes</th>
            <th className={styles.num}>Avg Deal</th>
            <th className={styles.num}>Dials</th>
            <th className={styles.num}>Texts</th>
          </tr>
        </thead>
        <tbody>
          {byRep.map((r, i) => {
            const avgDeal = r.closes > 0 ? Math.round(r.revenue / r.closes) : 0;
            const color   = repColor(r.rep_name);
            const isTop   = i === 0 && r.revenue > 0;
            return (
              <tr key={r.rep_name} className={isTop ? styles.leaderRow : ''}>
                <td style={isTop
                  ? { boxShadow: `inset 3px 0 0 ${color}`, color: 'var(--text-muted)', fontSize: 12 }
                  : { color: 'var(--text-muted)', fontSize: 12 }}>
                  {r.revenue > 0 ? (ORDINALS[i+1] ?? `${i+1}th`) : '—'}
                </td>
                <td><span className={styles.repDot} style={{ background: color }} />{r.rep_name}</td>
                <td className={styles.num}>{r.revenue > 0 ? fmtUSD.format(r.revenue) : '—'}</td>
                <td className={styles.num}>{r.closes > 0 ? r.closes : '—'}</td>
                <td className={styles.num}>{avgDeal > 0 ? fmtUSD.format(avgDeal) : '—'}</td>
                <td className={styles.num}>{r.dials > 0 ? fmtNum.format(r.dials) : '—'}</td>
                <td className={styles.num}>{r.texts > 0 ? fmtNum.format(r.texts) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MonthlyBreakdownTable({ breakdown }) {
  if (!breakdown || breakdown.length === 0) return <div className={styles.emptyState}>No monthly data available</div>;
  const total = breakdown.reduce((acc, m) => ({ revenue: acc.revenue + m.revenue, closes: acc.closes + m.closes }), { revenue: 0, closes: 0 });
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Month</th>
            <th className={styles.num}>Revenue</th>
            <th className={styles.num}>Closes</th>
            <th className={styles.num}>Avg Deal</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((m) => {
            const avgDeal = m.closes > 0 ? Math.round(m.revenue / m.closes) : 0;
            return (
              <tr key={m.month}>
                <td>{fmtMonthFull(m.month)}</td>
                <td className={styles.num}>{fmtUSD.format(m.revenue)}</td>
                <td className={styles.num}>{m.closes}</td>
                <td className={styles.num}>{avgDeal > 0 ? fmtUSD.format(avgDeal) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className={styles.closesTotalRow}>
            <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{breakdown.length} month{breakdown.length !== 1 ? 's' : ''}</td>
            <td className={styles.num}>{fmtUSD.format(total.revenue)}</td>
            <td className={styles.num}>{total.closes}</td>
            <td className={styles.num}>{total.closes > 0 ? fmtUSD.format(Math.round(total.revenue / total.closes)) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── main component ───────────────────────────────────────────────────────────

export default function Sales() {
  const [data, setData]                   = useState(null);
  const [todayData, setTodayData]         = useState(null);
  const [annualData, setAnnualData]       = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth);
  const [expandedWeeks, setExpandedWeeks] = useState(new Set());
  const [syncing, setSyncing]             = useState(false);
  const [lastSynced, setLastSynced]       = useState(null);
  const [activeSection, setActiveSection] = useState('monthly');

  const monthlyRef = useRef(null);
  const weeklyRef  = useRef(null);
  const annualRef  = useRef(null);

  function prevMonth() {
    setSelectedMonth(m => {
      const [y, mo] = m.split('-').map(Number);
      const d = new Date(y, mo - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  }

  function nextMonth() {
    setSelectedMonth(m => {
      if (m >= getCurrentMonth()) return m;
      const [y, mo] = m.split('-').map(Number);
      const d = new Date(y, mo, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  }

  // Reload KPIs whenever selected month changes
  useEffect(() => {
    getSalesKPIs(selectedMonth).then(kpis => {
      setData(kpis);
      setLastSynced(new Date());
      const today = localDateStr();
      if (kpis.weekly_data?.length) {
        const curr = kpis.weekly_data.find(w => w.week_start <= today && w.week_end >= today);
        if (curr) setExpandedWeeks(new Set([curr.week_start]));
      }
    }).catch(err => console.error('KPI fetch error:', err));
  }, [selectedMonth]);

  // Today + annual data: loaded on mount and polled independently
  useEffect(() => {
    async function loadStatic() {
      const today = localDateStr();
      try {
        const [td, annual] = await Promise.all([getSalesToday(today), getSalesAnnual()]);
        setTodayData(td);
        setAnnualData(annual);
      } catch (err) {
        console.error('Static fetch error:', err);
      }
    }
    loadStatic();
    const timer = setInterval(loadStatic, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function onScroll() {
      const sections = [
        { id: 'monthly', ref: monthlyRef },
        { id: 'weekly',  ref: weeklyRef },
        { id: 'annual',  ref: annualRef },
      ];
      for (let i = sections.length - 1; i >= 0; i--) {
        const el = sections[i].ref.current;
        if (el && el.getBoundingClientRect().top <= 130) {
          setActiveSection(sections[i].id);
          return;
        }
      }
      setActiveSection('monthly');
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      await triggerSalesSync();
      const today = localDateStr();
      const [kpis, td, annual] = await Promise.all([
        getSalesKPIs(selectedMonth),
        getSalesToday(today),
        getSalesAnnual(),
      ]);
      setData(kpis);
      setTodayData(td);
      setAnnualData(annual);
      setLastSynced(new Date());
    } catch (err) {
      console.error('Sync error:', err);
    } finally {
      setSyncing(false);
    }
  }

  function scrollTo(section) {
    setActiveSection(section);
    const refs = { monthly: monthlyRef, weekly: weeklyRef, annual: annualRef };
    refs[section]?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── derived ──────────────────────────────────────────────────────────────────

  const todayStr     = localDateStr();
  const totals       = data?.totals         ?? {};
  const monthlyByRep = data?.monthly_by_rep ?? [];
  const weekGroups   = groupByWeek(data?.weekly_data ?? []);
  const leadSources  = data?.lead_sources   ?? [];
  const locations    = data?.locations      ?? [];

  const currentWeek      = weekGroups.find(wk => todayStr >= wk.week_start && todayStr <= wk.week_end);
  const currentWeekReps  = currentWeek?.reps ?? [];
  const weeklySparklines = buildWeeklySparklines(
    data?.sparklines_raw ?? [],
    currentWeekReps.map(r => r.rep_name),
    currentWeek?.week_start,
    currentWeek?.week_end,
  );

  const weekTotals = currentWeekReps.reduce(
    (acc, r) => ({ revenue: acc.revenue + r.revenue, closes: acc.closes + r.closes }),
    { revenue: 0, closes: 0 }
  );

  const byRep     = todayData?.by_rep ?? [];
  const todayTotals = byRep.reduce(
    (acc, r) => ({ revenue: acc.revenue + r.revenue, closes: acc.closes + r.closes }),
    { revenue: 0, closes: 0 }
  );

  // Monthly chart data
  const repBarData = monthlyByRep
    .filter(r => r.revenue > 0)
    .map(r => ({ name: r.rep_name, revenue: r.revenue, fill: repColor(r.rep_name) }));

  const locBarData = locations.map(l => ({
    location: l.location === 'Fort Worth' ? 'Ft Worth' : l.location,
    revenue:  l.revenue,
  }));

  // Annual chart data
  const annualRepBarData = (annualData?.by_rep ?? [])
    .filter(r => r.revenue > 0)
    .map(r => ({ name: r.rep_name, revenue: r.revenue, fill: repColor(r.rep_name) }));

  const annualLocBarData = (annualData?.locations ?? [])
    .filter(l => l.revenue > 0)
    .map(l => ({
      location: l.location === 'Fort Worth' ? 'Ft Worth' : l.location,
      revenue:  l.revenue,
    }));

  const monthlyChartData = (annualData?.monthly_breakdown ?? []).map(m => ({
    month:   fmtMonthShort(m.month),
    revenue: m.revenue,
    closes:  m.closes,
  }));

  // ─── render ───────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>

      {/* ── Sticky sub-nav ── */}
      <div className={styles.subNav}>
        <div className={styles.subNavTabs}>
          {['monthly', 'weekly', 'annual'].map(sec => (
            <button
              key={sec}
              className={`${styles.subNavTab} ${activeSection === sec ? styles.subNavTabActive : ''}`}
              onClick={() => scrollTo(sec)}
            >
              {sec.charAt(0).toUpperCase() + sec.slice(1)}
            </button>
          ))}
        </div>
        <div className={styles.subNavRight}>
          {lastSynced && (
            <span className={styles.syncedAt}>
              Updated {new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(lastSynced)}
            </span>
          )}
          <button className={styles.syncBtn} onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* ── Always-visible summary strip ── */}
      <SummaryStrip totals={totals} weekTotals={weekTotals} todayTotals={todayTotals} selectedMonth={selectedMonth} />

      {/* ════════════════════════════════════════════════════════════
          MONTHLY
      ════════════════════════════════════════════════════════════ */}
      <section ref={monthlyRef} className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Monthly</span>
          <div className={styles.monthNav}>
            <button className={styles.monthNavBtn} onClick={prevMonth}>‹</button>
            <span className={styles.sectionDate}>{fmtMonthFull(selectedMonth)}</span>
            <button className={styles.monthNavBtn} onClick={nextMonth} disabled={selectedMonth >= getCurrentMonth()}>›</button>
          </div>
        </div>

        <MonthlyKPIStrip totals={totals} />
        <SpotlightCards monthlyByRep={monthlyByRep} />

        <p className={styles.sectionLabel}>Leaderboard</p>
        <Leaderboard reps={monthlyByRep} />

        <p className={styles.sectionLabel}>Insights</p>
        <div className={styles.charts3}>

          <div className={styles.chartCard}>
            <p className={styles.chartTitle}>Revenue by Rep</p>
            {repBarData.length === 0
              ? <div className={styles.emptyChart}>No data</div>
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={repBarData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip content={<Tt />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                      {repBarData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )
            }
          </div>

          <div className={styles.chartCard}>
            <p className={styles.chartTitle}>Revenue by Location</p>
            {locBarData.length === 0
              ? <div className={styles.emptyChart}>No data</div>
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={locBarData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                    <XAxis dataKey="location" tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={40} domain={[0, 120000]} />
                    <Tooltip content={<Tt />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="revenue" fill="#E8593C" radius={[4, 4, 0, 0]} />
                    <ReferenceLine y={100000} stroke="rgba(255,255,255,0.4)" strokeDasharray="4 3"
                      label={{ value: '$100k', position: 'insideTopRight', fill: 'rgba(255,255,255,0.4)', fontSize: 10 }} />
                  </BarChart>
                </ResponsiveContainer>
              )
            }
          </div>

          <div className={styles.chartCard}>
            <p className={styles.chartTitle}>Lead Sources</p>
            <LeadSourcesDonut leadSources={leadSources} />
          </div>

        </div>

      </section>

      <div className={styles.sectionBreak} />

      {/* ════════════════════════════════════════════════════════════
          WEEKLY
      ════════════════════════════════════════════════════════════ */}
      <section ref={weeklyRef} className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Weekly</span>
          {currentWeek && (
            <span className={styles.sectionDate}>{fmtWeek(currentWeek.week_start, currentWeek.week_end)}</span>
          )}
        </div>

        {currentWeekReps.length > 0
          ? (
            <div className={styles.repGrid}>
              {currentWeekReps.map((rep) => (
                <WeeklyRepCard
                  key={rep.rep_name}
                  rep={rep}
                  weeklySparkline={weeklySparklines[rep.rep_name]}
                />
              ))}
            </div>
          )
          : <div className={styles.emptyState}>No data for current week</div>
        }

        <WeekAccordion
          weekGroups={weekGroups}
          expandedWeeks={expandedWeeks}
          setExpandedWeeks={setExpandedWeeks}
          todayStr={todayStr}
        />
      </section>

      <div className={styles.sectionBreak} />

      {/* ════════════════════════════════════════════════════════════
          ANNUAL
      ════════════════════════════════════════════════════════════ */}
      <section ref={annualRef} className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Annual</span>
          <span className={styles.sectionDate}>{annualData?.year ?? new Date().getFullYear()}</span>
        </div>

        <AnnualKPIStrip annualData={annualData} />

        <p className={styles.sectionLabel}>YTD Leaderboard</p>
        <AnnualLeaderboard byRep={annualData?.by_rep ?? []} />

        <p className={styles.sectionLabel}>Monthly Breakdown</p>
        {monthlyChartData.length > 0 && (
          <div className={styles.chartCard} style={{ padding: '20px 20px 8px' }}>
            <p className={styles.chartTitle}>Revenue by Month</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={monthlyChartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                <Tooltip content={<Tt />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="revenue" fill="#E8593C" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <MonthlyBreakdownTable breakdown={annualData?.monthly_breakdown ?? []} />

        <p className={styles.sectionLabel}>Annual Insights</p>
        <div className={styles.charts3}>

          <div className={styles.chartCard}>
            <p className={styles.chartTitle}>Revenue by Rep — YTD</p>
            {annualRepBarData.length === 0
              ? <div className={styles.emptyChart}>No data</div>
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={annualRepBarData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip content={<Tt />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                      {annualRepBarData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )
            }
          </div>

          <div className={styles.chartCard}>
            <p className={styles.chartTitle}>Revenue by Location — YTD</p>
            {annualLocBarData.length === 0
              ? <div className={styles.emptyChart}>No data</div>
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={annualLocBarData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                    <XAxis dataKey="location" tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip content={<Tt />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="revenue" fill="#E8593C" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )
            }
          </div>

          <div className={styles.chartCard}>
            <p className={styles.chartTitle}>Lead Sources — YTD</p>
            <LeadSourcesDonut leadSources={annualData?.lead_sources ?? []} />
          </div>

        </div>
      </section>

    </div>
  );
}
