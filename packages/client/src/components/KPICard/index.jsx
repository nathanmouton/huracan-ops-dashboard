import styles from './index.module.css';

const fmtCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const fmtNumber = new Intl.NumberFormat('en-US');

export default function KPICard({ label, value, format = 'number' }) {
  const display = value == null
    ? '—'
    : format === 'currency'
      ? fmtCurrency.format(value)
      : fmtNumber.format(value);

  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{display}</div>
    </div>
  );
}
