import styles from './index.module.css';

const STATUS_LABEL = {
  scheduled:   'Scheduled',
  in_progress: 'In Progress',
  completed:   'Completed',
  cancelled:   'Cancelled',
};

const fmtCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

function fmtDate(str) {
  if (!str) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(str));
}

export default function OpsTable({ jobs = [] }) {
  if (jobs.length === 0) {
    return <div className={styles.empty}>No jobs to display.</div>;
  }

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Rep</th>
            <th>Customer</th>
            <th>Service</th>
            <th>Vehicle</th>
            <th>Status</th>
            <th>Revenue</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>{job.rep_name}</td>
              <td>{job.customer_name}</td>
              <td>{job.service_type}</td>
              <td className={styles.muted}>{job.vehicle}</td>
              <td>
                <span className={`${styles.pill} ${styles[job.status]}`}>
                  {STATUS_LABEL[job.status] ?? job.status}
                </span>
              </td>
              <td className={styles.num}>{fmtCurrency.format(job.revenue)}</td>
              <td className={styles.muted}>{fmtDate(job.date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
