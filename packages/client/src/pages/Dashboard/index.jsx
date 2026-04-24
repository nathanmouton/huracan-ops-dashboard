import { useState, useEffect } from 'react';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import KPICard from '../../components/KPICard/index.jsx';
import OpsTable from '../../components/OpsTable/index.jsx';
import { getKPIs, getRevenueByRep, getDailyRevenue, getRecentJobs } from '../../api/index.js';
import styles from './index.module.css';

const C = {
  grid:    '#252525',
  axis:    '#555',
  accent:  '#E8593C',
  ttBg:    '#1e1e1e',
  ttBorder:'#333',
};

const fmtK = (v) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`;
const fmtDay = (s) => { const d = new Date(s + 'T00:00:00'); return `${d.getMonth() + 1}/${d.getDate()}`; };

function ChartTooltip({ active, payload, label, prefix = '' }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: C.ttBg, border: `1px solid ${C.ttBorder}`,
      borderRadius: 6, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#fff', fontWeight: 600 }}>
        {prefix}
        {new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(payload[0].value)}
      </div>
    </div>
  );
}

const POLL_MS = 5 * 60 * 60 * 1000; // 5 hours

export default function Dashboard({ locationId, onSyncChange }) {
  const [kpis, setKpis]               = useState(null);
  const [byRep, setByRep]             = useState([]);
  const [daily, setDaily]             = useState([]);
  const [jobs, setJobs]               = useState([]);

  useEffect(() => {
    let live = true;

    async function fetchAll() {
      onSyncChange(null, true);
      try {
        const [k, r, d, j] = await Promise.all([
          getKPIs(locationId),
          getRevenueByRep(locationId),
          getDailyRevenue(locationId),
          getRecentJobs(locationId),
        ]);
        if (!live) return;
        setKpis(k);
        setByRep(r);
        setDaily(d);
        setJobs(j);
        onSyncChange(new Date(), false);
      } catch (err) {
        console.error('Dashboard fetch error:', err);
        if (live) onSyncChange(null, false);
      }
    }

    fetchAll();
    const timer = setInterval(fetchAll, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [locationId, onSyncChange]);

  return (
    <div className={styles.page}>

      {/* KPI row */}
      <section className={styles.kpis}>
        <KPICard label="Total Revenue"      value={kpis?.total_revenue}     format="currency" />
        <KPICard label="Jobs Completed"     value={kpis?.jobs_completed} />
        <KPICard label="Open Appointments"  value={kpis?.open_appointments} />
        <KPICard label="Upsells This Week"  value={kpis?.upsells_this_week} format="currency" />
      </section>

      {/* Charts row */}
      <section className={styles.charts}>

        <div className={styles.chartCard}>
          <p className={styles.chartTitle}>Revenue by Rep — This Week</p>
          {byRep.length === 0
            ? <div className={styles.empty}>No completed jobs this week</div>
            : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byRep} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="rep_name" tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip content={<ChartTooltip prefix="$" />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="revenue" fill={C.accent} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )
          }
        </div>

        <div className={styles.chartCard}>
          <p className={styles.chartTitle}>Daily Revenue — Past 30 Days</p>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={daily} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={fmtDay}
                interval={6}
                tick={{ fill: C.axis, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis tickFormatter={fmtK} tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip content={<ChartTooltip prefix="$" />} />
              <Line
                type="monotone"
                dataKey="revenue"
                stroke={C.accent}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: C.accent, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

      </section>

      {/* Jobs table */}
      <section className={styles.tableSection}>
        <p className={styles.sectionLabel}>Recent Jobs</p>
        <OpsTable jobs={jobs} />
      </section>

    </div>
  );
}
